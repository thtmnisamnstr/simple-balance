{{/*
Chart name, and the release-qualified name every object is built from. Both are
truncated to the 63 characters a label value and a DNS name allow.
*/}}
{{- define "simple-balance.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "simple-balance.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 52 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 52 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 52 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Truncated to 52 above rather than 63 so that appending the longest component
name still fits inside 63.
*/}}
{{- define "simple-balance.componentName" -}}
{{- printf "%s-%s" (include "simple-balance.fullname" .root) .component | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "simple-balance.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "simple-balance.selectorLabels" -}}
app.kubernetes.io/name: {{ include "simple-balance.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "simple-balance.labels" -}}
helm.sh/chart: {{ include "simple-balance.chart" . }}
{{ include "simple-balance.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: simple-balance
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "simple-balance.componentSelectorLabels" -}}
{{ include "simple-balance.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "simple-balance.componentLabels" -}}
{{ include "simple-balance.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "simple-balance.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "simple-balance.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
An image reference. The tag falls back to the chart's appVersion so that an
upgrade moves all three workloads together by default.
*/}}
{{- define "simple-balance.image" -}}
{{- $registry := .image.registry | default .root.Values.global.imageRegistry }}
{{- $tag := .image.tag | default .root.Chart.AppVersion }}
{{- if $registry }}
{{- printf "%s/%s:%s" $registry .image.repository $tag }}
{{- else }}
{{- printf "%s:%s" .image.repository $tag }}
{{- end }}
{{- end }}

{{- define "simple-balance.configMapName" -}}
{{- printf "%s-config" (include "simple-balance.fullname" .) }}
{{- end }}

{{/*
The Secret holding the credentials, whichever way it got there. Refusing both at
once is the point: an operator who names an existing Secret and leaves create on
would otherwise get a chart-built Secret alongside it and no sign of which one
the pods read.
*/}}
{{- define "simple-balance.secretName" -}}
{{- if and .Values.secret.create .Values.secret.existingSecret }}
{{- fail "secret.create is true and secret.existingSecret names a Secret. Set secret.create=false to use the one that exists, or clear secret.existingSecret to have the chart build it." }}
{{- end }}
{{- if .Values.secret.existingSecret }}
{{- .Values.secret.existingSecret }}
{{- else if .Values.secret.create }}
{{- printf "%s-env" (include "simple-balance.fullname" .) }}
{{- else }}
{{- fail "No Secret. Set secret.create=true with secret.databaseUrl and secret.authSecret, or point secret.existingSecret at a Secret already carrying DATABASE_URL and AUTH_SECRET." }}
{{- end }}
{{- end }}

{{/*
Everything the API and the scheduler both read, in one place. Rendered into the
ConfigMap and hashed into both pod templates, so a settings change rolls them.
*/}}
{{- define "simple-balance.sharedEnv" -}}
{{- $c := .Values.config -}}
# The images set this too. Repeating it means an image built or tagged wrong
# cannot quietly come up with the first-run setup code, the sign-in rate limit
# and secure cookies all switched off, which is the one misconfiguration with no
# symptom.
NODE_ENV: "production"
APP_BASE_URL: {{ $c.appBaseUrl | quote }}
AUTH_MODE: {{ $c.authMode | quote }}
LOG_LEVEL: {{ $c.logLevel | quote }}
PORT: {{ $c.port | int64 | quote }}
TRUST_PROXY: {{ $c.trustProxy | quote }}
# int64 before quote, or Helm hands YAML's float64 to the string conversion and
# CSV_MAX_BYTES arrives as 1.048576e+07, which is not a number the server reads.
CSV_MAX_BYTES: {{ $c.csvMaxBytes | int64 | quote }}
CSV_MAX_ROWS: {{ $c.csvMaxRows | int64 | quote }}
DATABASE_POOL_SIZE: {{ $c.databasePoolSize | int64 | quote }}
RECURRENCE_TICK_SECONDS: {{ $c.recurrence.tickSeconds | int64 | quote }}
RECURRENCE_CATCH_UP_LIMIT: {{ $c.recurrence.catchUpLimit | int64 | quote }}
RECURRENCE_CLAIM_LIMIT: {{ $c.recurrence.claimLimit | int64 | quote }}
METRICS_ENABLED: {{ $c.metrics.enabled | quote }}
{{- with $c.allowedEmails }}
ALLOWED_EMAILS: {{ . | quote }}
{{- end }}
{{- with $c.google.clientId }}
GOOGLE_CLIENT_ID: {{ . | quote }}
{{- end }}
{{- if $c.mail.host }}
SMTP_HOST: {{ $c.mail.host | quote }}
MAIL_FROM: {{ $c.mail.from | quote }}
SMTP_PORT: {{ $c.mail.port | int64 | quote }}
SMTP_SSL: {{ $c.mail.ssl | quote }}
{{- with $c.mail.replyTo }}
MAIL_REPLY_TO: {{ . | quote }}
{{- end }}
{{- end }}
{{- range $name, $value := $c.extraEnv }}
{{- /*
The same hazard the numeric settings above are guarded against, and this is the
one place a value's type is not known in advance. YAML reads a bare number as a
float64, and quoting that directly gives 1.048576e+07 rather than 10485760.
*/}}
{{ $name }}: {{ if kindIs "float64" $value }}{{ $value | int64 | quote }}{{ else }}{{ $value | quote }}{{ end }}
{{- end }}
{{- end }}

{{/*
Everything getConfig() refuses to start without, checked while a template render
can still say so. Each of these otherwise surfaces as a crashlooping pod and a
stack trace in `kubectl logs`.
*/}}
{{- define "simple-balance.validate" -}}
{{- $c := .Values.config }}
{{- /*
The origin this chart ships is a placeholder and every deployment has to replace
it. Left in place it renders, installs and runs, and then sets cookies for a
domain nobody reaches and mints OAuth and MCP audiences naming it, which fails
as a sign-in that never completes rather than as anything that mentions this
setting. Refused by name for the same reason config.ts refuses the AUTH_SECRETs
this project has published.
*/}}
{{- if hasSuffix "simple-balance.example.com" (trimSuffix "/" $c.appBaseUrl) }}
{{- fail "config.appBaseUrl is still the example this chart ships. Set it to the origin your Ingress answers on: cookies, the OAuth issuer and the audience on MCP tokens are all derived from it." }}
{{- end }}
{{- if not (regexMatch "^https?://[^/?#]+/?$" $c.appBaseUrl) }}
{{- fail (printf "config.appBaseUrl must be a bare origin such as https://balance.example.com, with no path, query or fragment. Got %q." $c.appBaseUrl) }}
{{- end }}
{{- $host := regexReplaceAll "^https?://" (trimSuffix "/" $c.appBaseUrl) "" }}
{{- if and (hasPrefix "http://" $c.appBaseUrl) (not (or (hasPrefix "localhost" $host) (hasPrefix "127." $host))) }}
{{- fail (printf "config.appBaseUrl must use HTTPS outside loopback. Got %q." $c.appBaseUrl) }}
{{- end }}
{{- if or (eq $c.authMode "google") (eq $c.authMode "both") }}
{{- if not $c.google.clientId }}
{{- fail "config.authMode enables Google sign-in, so config.google.clientId is required." }}
{{- end }}
{{- if and .Values.secret.create (not .Values.secret.googleClientSecret) }}
{{- fail "config.authMode enables Google sign-in, so secret.googleClientSecret is required." }}
{{- end }}
{{- if not $c.allowedEmails }}
{{- fail "config.allowedEmails must list who may register when Google sign-in is on: addresses, domains such as example.com, or * for anybody." }}
{{- end }}
{{- end }}
{{- if not (eq (empty $c.mail.host) (empty $c.mail.from)) }}
{{- fail "config.mail.host and config.mail.from are set together or not at all. Half a mail configuration is a deployment that believes it can send a password reset and cannot." }}
{{- end }}
{{/*
The third line-up rule, checked like the other two rather than trusted to a
comment: a CSV travels as a JSON string, so the API's body limit on the import
routes is csvMaxBytes x 6 plus 64 KiB, and nginx has to accept at least that or
an import inside the documented limit dies at the proxy with a 413 the API
never sees.
*/}}
{{- $upload := .Values.frontend.maxUploadSize | toString | lower }}
{{- if not (regexMatch "^[0-9]+[kmg]?$" $upload) }}
{{- fail (printf "frontend.maxUploadSize must be an nginx size such as 61m. Got %q." $upload) }}
{{- end }}
{{- $uploadDigits := regexFind "^[0-9]+" $upload | int64 }}
{{- $uploadUnit := regexFind "[kmg]$" $upload }}
{{- $uploadBytes := $uploadDigits }}
{{- if eq $uploadUnit "k" }}{{- $uploadBytes = mul $uploadDigits 1024 }}{{- end }}
{{- if eq $uploadUnit "m" }}{{- $uploadBytes = mul $uploadDigits 1048576 }}{{- end }}
{{- if eq $uploadUnit "g" }}{{- $uploadBytes = mul $uploadDigits 1073741824 }}{{- end }}
{{- $csvBodyBytes := add (mul (int64 $c.csvMaxBytes) 6) 65536 }}
{{- if lt (int64 $uploadBytes) $csvBodyBytes }}
{{- fail (printf "frontend.maxUploadSize (%s) is below what config.csvMaxBytes needs: a CSV travels as a JSON string, so the API accepts up to %d bytes on the import routes and nginx must too. Raise frontend.maxUploadSize to at least that." $upload (int64 $csvBodyBytes)) }}
{{- end }}
{{- if and .Values.database.enabled .Values.secret.databaseUrl }}
{{- fail "database.enabled and secret.databaseUrl are both set. One runs a Citus cluster in this release and the other points at a database somebody else runs; pick the one you meant rather than letting the chart choose." }}
{{- end }}
{{- if and .Values.database.enabled (not .Values.secret.create) }}
{{- fail "database.enabled needs secret.create: the connection string for the cluster this chart runs is derived here, and an existingSecret would have to carry a password this chart generates." }}
{{- end }}
{{- if .Values.secret.create }}
{{- if and (not .Values.secret.databaseUrl) (not .Values.database.enabled) }}
{{- fail "secret.databaseUrl is required when secret.create is true. The database is bring your own unless database.enabled is set, which runs the ha profile's Citus cluster in this release." }}
{{- end }}
{{- if not .Values.secret.authSecret }}
{{- fail "secret.authSecret is required when secret.create is true. Generate one with `openssl rand -base64 32`." }}
{{- end }}
{{- if lt (len .Values.secret.authSecret) 32 }}
{{- fail "secret.authSecret must be at least 32 characters. Startup refuses a shorter one, so the release would install cleanly and then crashloop every tier." }}
{{- end }}
{{- if has (trim .Values.secret.authSecret) (list "development-only-secret-change-me-1234567890" "replace-with-at-least-32-random-characters" "change-me") }}
{{- fail "secret.authSecret is one of the published placeholders. Sessions are signed with it, so it has to be a secret nobody else has. Generate one with `openssl rand -base64 32`." }}
{{- end }}
{{- if and .Values.secret.setupToken (lt (len .Values.secret.setupToken) 16) }}
{{- fail "secret.setupToken must be at least 16 characters when it is set. Startup refuses a shorter one." }}
{{- end }}
{{- if not (eq (empty .Values.secret.smtpUsername) (empty .Values.secret.smtpPassword)) }}
{{- fail "secret.smtpUsername and secret.smtpPassword are set together or not at all." }}
{{- end }}
{{- end }}
{{- end }}

{{/*
One HorizontalPodAutoscaler, given a component name and its autoscaling block.
*/}}
{{- define "simple-balance.hpa" -}}
{{- if .autoscaling.enabled }}
{{- $a := .autoscaling }}
{{- if not (or $a.targetCPUUtilizationPercentage $a.targetMemoryUtilizationPercentage) }}
{{- fail (printf "autoscaling is enabled for the %s workload with neither a CPU nor a memory target. An HPA with no metrics has nothing to scale on." .component) }}
{{- end }}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "simple-balance.componentName" (dict "root" .root "component" .component) }}
  labels:
    {{- include "simple-balance.componentLabels" (dict "root" .root "component" .component) | nindent 4 }}
  {{- with .root.Values.commonAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "simple-balance.componentName" (dict "root" .root "component" .component) }}
  minReplicas: {{ $a.minReplicas }}
  maxReplicas: {{ $a.maxReplicas }}
  metrics:
    {{- with $a.targetCPUUtilizationPercentage }}
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ . }}
    {{- end }}
    {{- with $a.targetMemoryUtilizationPercentage }}
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: {{ . }}
    {{- end }}
  behavior:
    scaleUp:
      stabilizationWindowSeconds: {{ $a.scaleUpStabilizationWindowSeconds }}
    scaleDown:
      stabilizationWindowSeconds: {{ $a.scaleDownStabilizationWindowSeconds }}
{{- end }}
{{- end }}

{{/*
One PodDisruptionBudget. minAvailable and maxUnavailable are mutually exclusive
in the API, so a chart offering both has to refuse both at once itself.
*/}}
{{- define "simple-balance.pdb" -}}
{{- if .pdb.enabled }}
{{- if and .pdb.minAvailable .pdb.maxUnavailable }}
{{- fail (printf "%s.podDisruptionBudget sets both minAvailable and maxUnavailable. A PodDisruptionBudget takes one or the other." .component) }}
{{- end }}
{{- if not (or .pdb.minAvailable .pdb.maxUnavailable) }}
{{- fail (printf "%s.podDisruptionBudget sets neither minAvailable nor maxUnavailable." .component) }}
{{- end }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "simple-balance.componentName" (dict "root" .root "component" .component) }}
  labels:
    {{- include "simple-balance.componentLabels" (dict "root" .root "component" .component) | nindent 4 }}
  {{- with .root.Values.commonAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with .pdb.minAvailable }}
  minAvailable: {{ . }}
  {{- end }}
  {{- with .pdb.maxUnavailable }}
  maxUnavailable: {{ . }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "simple-balance.componentSelectorLabels" (dict "root" .root "component" .component) | nindent 6 }}
{{- end }}
{{- end }}

{{/*
The database image, which the shared helper cannot build for two reasons.

Its tag is Citus's version rather than this chart's appVersion, so falling back
to appVersion — which is what the shared helper does with an empty tag — would
name an image that does not exist and say `0.2.0` while doing it. And a database
is the one image here worth pinning by digest, because a tag that moves under a
running cluster is how a PostgreSQL major version arrives unannounced, and a
major version cannot read the previous major's data directory.
*/}}
{{- define "simple-balance.databaseImage" -}}
{{- $image := .Values.database.image -}}
{{- $registry := $image.registry | default .Values.global.imageRegistry -}}
{{- $repository := $image.repository -}}
{{- if $registry -}}
{{- $repository = printf "%s/%s" $registry $repository -}}
{{- end -}}
{{- if $image.digest -}}
{{- printf "%s@%s" $repository $image.digest -}}
{{- else if $image.tag -}}
{{- printf "%s:%s" $repository $image.tag -}}
{{- else -}}
{{- fail "database.image needs a tag or a digest: it is versioned by Citus and PostgreSQL, not by this chart" -}}
{{- end -}}
{{- end }}

{{/*
Names for the database objects. The Citus group is part of the name because
Patroni keys its Kubernetes state on it: one scope per group, each with its own
leader endpoint, and the coordinator is always group 0.
*/}}
{{- define "simple-balance.databaseName" -}}
{{- printf "%s-db" (include "simple-balance.fullname" .) | trunc 58 | trimSuffix "-" }}
{{- end }}

{{- define "simple-balance.databaseGroupName" -}}
{{- printf "%s-%d" (include "simple-balance.databaseName" .root) (int .group) }}
{{- end }}

{{- define "simple-balance.databaseSecretName" -}}
{{- printf "%s-credentials" (include "simple-balance.databaseName" .) }}
{{- end }}

{{/*
Where the application connects. The coordinator's leader Service, which Patroni
keeps pointing at whichever group-0 pod is currently primary — that is the whole
point of running it. A worker is never connected to directly: Citus routes.
*/}}
{{- define "simple-balance.databaseUrl" -}}
{{- $db := .Values.database -}}
{{- $host := include "simple-balance.databaseGroupName" (dict "root" . "group" 0) -}}
{{- printf "postgresql://%s:%s@%s:5432/%s" $db.application.username (include "simple-balance.databaseApplicationPassword" .) $host $db.databaseName -}}
{{- end }}

{{/*
The three database passwords, decided once per render and kept across upgrades.

Three things have to be true at once and none of them is the default behaviour.
A password the operator set wins. A password already in the cluster is kept,
because rolling the superuser password out from under a running Patroni cluster
on every `helm upgrade` would break replication and the failover with it. And a
generated one is generated exactly once per render: `randAlphaNum` called from
three templates gives three different answers, which is the classic way a chart
writes a Secret the StatefulSet disagrees with.

So they are resolved together, cached on .Values, and every caller goes through
here. The schema has already been validated by the time templates render, so
adding the key does not fail validation.
*/}}
{{- define "simple-balance.databaseCredentials" -}}
{{- if not (hasKey .Values.database "resolvedPasswords") -}}
  {{- $existing := (lookup "v1" "Secret" .Release.Namespace (include "simple-balance.databaseSecretName" .)) -}}
  {{- $data := dict -}}
  {{- if $existing -}}
    {{- $data = (default dict $existing.data) -}}
  {{- end -}}
  {{- $resolved := dict -}}
  {{- range $role := (list "superuser" "replication" "application") -}}
    {{- $configured := (index $.Values.database $role).password -}}
    {{- $key := printf "%s-password" $role -}}
    {{- if $configured -}}
      {{- $_ := set $resolved $role $configured -}}
    {{- else if hasKey $data $key -}}
      {{- $_ := set $resolved $role (index $data $key | b64dec) -}}
    {{- else -}}
      {{- $_ := set $resolved $role (randAlphaNum 32) -}}
    {{- end -}}
  {{- end -}}
  {{- $_ := set .Values.database "resolvedPasswords" $resolved -}}
{{- end -}}
{{- end }}

{{- define "simple-balance.databaseSuperuserPassword" -}}
{{- include "simple-balance.databaseCredentials" . -}}
{{- .Values.database.resolvedPasswords.superuser -}}
{{- end }}

{{- define "simple-balance.databaseReplicationPassword" -}}
{{- include "simple-balance.databaseCredentials" . -}}
{{- .Values.database.resolvedPasswords.replication -}}
{{- end }}

{{- define "simple-balance.databaseApplicationPassword" -}}
{{- include "simple-balance.databaseCredentials" . -}}
{{- .Values.database.resolvedPasswords.application -}}
{{- end }}

{{/*
Every Citus group this release runs: 0 is the coordinator, the rest are workers.
*/}}
{{- define "simple-balance.databaseGroups" -}}
{{- $groups := list 0 -}}
{{- range $i := until (int .Values.database.workers) -}}
{{- $groups = append $groups (add1 $i) -}}
{{- end -}}
{{- toJson $groups -}}
{{- end }}
