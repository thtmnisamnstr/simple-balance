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
{{- if .Values.secret.create }}
{{- if not .Values.secret.databaseUrl }}
{{- fail "secret.databaseUrl is required when secret.create is true. The database is bring your own; nothing in this chart provisions one." }}
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
