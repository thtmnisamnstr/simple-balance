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
What the frontend is told about Stripe and about AdSense, as the "true" or
"false" the nginx template's map directives compare against.

nginx serves every page in this shape, so it decides the policy each arrives
with, and these two are all it knows. Told neither, a server with Stripe set up
opens a plan tab whose card fields never load, and one with AdSense set up has
every page block the script it asks for, and nothing in any pod says why.

So each is derived the way the compose recipes derive it, from its key being
set in config.extraEnv, and the switch is kept beside the key rather than
replaced by it, for a key that reaches the pods by a route this render cannot
read, such as an existingSecret or a post-renderer. Derived rather than refused
when the two disagree, because a values file 0.1.6 rendered may carry anything
in extraEnv, and a setting that was accepted stays accepted.

Set means what the pods receive is not blank, because the server trims the
value and reads a blank one as unset; a false or a 0 arrives as text and counts.
And extraEnv defaults to a dict here because a values file whose extraEnv holds
only commented lines, or --set config.extraEnv=null, leaves it null, which `get`
refuses and 0.1.6 rendered.
*/}}
{{- define "simple-balance.extraEnvIsSet" -}}
{{- $value := get (.root.Values.config.extraEnv | default dict) .name -}}
{{- if not (kindIs "invalid" $value) }}{{ if trim (toString $value) }}true{{ end }}{{ end -}}
{{- end }}

{{- define "simple-balance.billingConfigured" -}}
{{- if or .Values.frontend.billingConfigured (include "simple-balance.extraEnvIsSet" (dict "root" . "name" "STRIPE_PUBLISHABLE_KEY")) }}true{{ else }}false{{ end -}}
{{- end }}

{{- define "simple-balance.adsConfigured" -}}
{{- if or .Values.frontend.adsConfigured (include "simple-balance.extraEnvIsSet" (dict "root" . "name" "ADSENSE_CLIENT_ID")) }}true{{ else }}false{{ end -}}
{{- end }}

{{/*
frontend.trustedProxyCidr as the one string SB_TRUSTED_PROXY_CIDR carries. A
YAML list is joined with commas, which the image splits on; a string passes
through as written, so a values file that set one CIDR renders exactly the
value it always did. The deployment and NOTES.txt both read it from here, so
the warning about the off position cannot disagree with what the pod receives.
A key removed with null is the off position, where it used to render nothing
and a pod that would not start; the schema refuses an empty string or list
before this is reached, so `default` changes nothing else.
*/}}
{{- define "simple-balance.trustedProxies" -}}
{{- $trusted := .Values.frontend.trustedProxyCidr | default "127.0.0.1" -}}
{{- if kindIs "slice" $trusted }}{{ join ", " $trusted }}{{ else }}{{ trim (toString $trusted) }}{{ end -}}
{{- end }}

{{/*
The Secret this chart builds, when it builds one. Named on its own rather than
through the list below, because the two answer different questions: this is the
name of an object this render creates, and `secretRefs` is what the pods read —
which may be this one, an operator's, or both.
*/}}
{{- define "simple-balance.ownSecretName" -}}
{{- printf "%s-env" (include "simple-balance.fullname" .) }}
{{- end }}

{{/*
Every Secret the API and the scheduler take their environment from, in the order
`envFrom` has to list them.

One source is the ordinary case and was the only one before this release: the
chart's own Secret, or an operator's `existingSecret`. Naming both was refused,
and still is wherever the chart is not running the database, because two sources
of DATABASE_URL with no stated precedence is a deployment nobody can reason
about.

Both at once exists for exactly one shape, and it is the shape the `ha` profile's
Pulumi programs are in. The connection string for a cluster this chart runs can
only be derived here — the password is generated here — while the rest of the
credentials must not travel through chart values, because chart values land in
the release Secret and in Helm's history, which is the whole reason those
programs build their own Secret. So with `database.enabled` the chart's Secret
carries the derived DATABASE_URL and the operator's carries everything else.

The order is the contract. Kubernetes lets a later `envFrom` source win a
duplicate key, so the operator's Secret goes second and what they supplied beats
what this render worked out — the precedence every other setting here has.
*/}}
{{- define "simple-balance.secretRefs" -}}
{{- if and .Values.secret.create .Values.secret.existingSecret (not .Values.database.enabled) }}
{{- fail "secret.create is true and secret.existingSecret names a Secret. Set secret.create=false to use the one that exists, or clear secret.existingSecret to have the chart build it. Both together mean something only with database.enabled, where the chart derives DATABASE_URL for the cluster it runs and the existing Secret carries the rest." }}
{{- end }}
{{- $names := list }}
{{- if .Values.secret.create }}
{{- $names = append $names (include "simple-balance.ownSecretName" .) }}
{{- end }}
{{- with .Values.secret.existingSecret }}
{{- $names = append $names . }}
{{- end }}
{{- if not $names }}
{{- fail "No Secret. Set secret.create=true with secret.databaseUrl and secret.authSecret, or point secret.existingSecret at a Secret already carrying DATABASE_URL and AUTH_SECRET." }}
{{- end }}
{{- toJson $names }}
{{- end }}

{{/*
Whether the chart's own Secret is the only place the credentials come from. With
an `existingSecret` beside it the chart derives DATABASE_URL and nothing else, so
every "required when secret.create" check below is about this rather than about
`create`: refusing a missing AUTH_SECRET there would refuse a deployment whose
AUTH_SECRET is sitting in the Secret it was told about.
*/}}
{{- define "simple-balance.ownsCredentials" -}}
{{- if and .Values.secret.create (not .Values.secret.existingSecret) }}true{{ end -}}
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
{{- $ownsCredentials := include "simple-balance.ownsCredentials" . }}
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
{{- if and $ownsCredentials (not .Values.secret.googleClientSecret) }}
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
{{/*
The one combination of the frontend's trust settings the image refuses that
the schema cannot see, because it spans two values: a range holding every
address with recursion on. nginx would then walk the whole header and take its
leftmost entry, which is the one the caller wrote, and the pod would exit at
startup saying so. Refused here instead, where it is a render error rather than
a rollout that never becomes ready.
*/}}
{{- if .Values.frontend.realIpRecursive }}
{{- range regexSplit "[\\s,]+" (include "simple-balance.trustedProxies" .) -1 }}
{{- if hasSuffix "/0" . }}
{{- fail (printf "frontend.trustedProxyCidr holds %s with frontend.realIpRecursive on, which believes whatever address a caller writes first in X-Forwarded-For. Name the proxies' own ranges, or turn recursion off." .) }}
{{- end }}
{{- end }}
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
{{- if $ownsCredentials }}
{{- if not .Values.secret.authSecret }}
{{- fail "secret.authSecret is required when secret.create is true. Generate one with `openssl rand -base64 32`." }}
{{- end }}
{{- if lt (len .Values.secret.authSecret) 32 }}
{{- fail "secret.authSecret must be at least 32 characters. Startup refuses a shorter one, so the release would install cleanly and then crashloop every tier." }}
{{- end }}
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
{{- if .Values.database.enabled }}
{{/*
A guarantee the cluster cannot give. `synchronous_mode_strict` is off — see
database-config.yaml, where keeping a ledger writable through one lost pod is
argued — so a group with no standby falls back to asynchronous and says nothing.
At one replica per group there is never a standby, so `synchronousReplication:
true` there is a setting that claims durability it can never deliver. Refused
rather than quietly derived to false, because the operator asked for something
and would otherwise be told nothing.
*/}}
{{- if and .Values.database.synchronousReplication (le (int .Values.database.replicasPerGroup) 1) }}
{{- fail "database.synchronousReplication is on with database.replicasPerGroup at 1. A commit waits for a standby to hold the WAL and there is no standby in a group of one, so this promises a durability the cluster cannot give. Set database.replicasPerGroup to at least 2, or database.synchronousReplication=false — the one-node-per-service shape does the latter in values-node-per-service.yaml." }}
{{- end }}
{{/*
The application password becomes the userinfo of a URL, so a character that
means something there silently truncates or reroutes the connection string
rather than failing. Generated passwords are alphanumeric and cannot hit this;
an operator's can, and the failure would be a pod that cannot connect and a
DATABASE_URL nobody may print to find out why.
*/}}
{{- if and .Values.database.application.password (not (regexMatch "^[A-Za-z0-9._~-]+$" .Values.database.application.password)) }}
{{- fail "database.application.password goes into the userinfo of the derived DATABASE_URL, so it is limited to letters, digits and . _ ~ - . Anything else would have to be percent-encoded, and an unencoded @ or / silently points the connection somewhere else. Leave it empty to have one generated." }}
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

`verify-full` rather than `require`, and the difference is not cosmetic.
node-postgres reads both as "use TLS and check the certificate", because
pg-connection-string returns the same empty `ssl` object for each and Node's
defaults then apply — so `require` here would read as a weaker guarantee than
the one actually in force, which is the divergence docs/deployment.md records.
Written as what it does.

`sslrootcert` names a file inside the API and scheduler containers, which the
deployments mount from the cluster's own Secret. It is load-bearing twice over:
pg-connection-string reads that file at parse time, so a pod that did not get
the mount fails at startup with ENOENT rather than connecting to something
unverified, and the CA it holds is this cluster's alone, so a certificate
signed by any public authority is not a certificate this application accepts.
*/}}
{{- define "simple-balance.databaseUrl" -}}
{{- $db := .Values.database -}}
{{- $host := include "simple-balance.databaseGroupName" (dict "root" . "group" 0) -}}
{{- printf "postgresql://%s:%s@%s:5432/%s?sslmode=verify-full&sslrootcert=%s" $db.application.username (include "simple-balance.databaseApplicationPassword" .) $host $db.databaseName (include "simple-balance.databaseCaPath" .) -}}
{{- end }}

{{/*
The three paths the certificate material lands on, hard-coded rather than made
settings for the reason `compose.db-tls.yml` hard-codes its own: a path that is
stated twice is a path that can disagree with itself, and nothing about either
number is a deployment's choice.

The first is inside the API and scheduler containers and is what the connection
string above names. The other two are inside the database containers and are
what PostgreSQL's `ssl_cert_file`, `ssl_key_file` and `ssl_ca_file` name.
*/}}
{{- define "simple-balance.databaseCaPath" -}}/etc/simple-balance/db-ca.pem{{- end }}
{{- define "simple-balance.databaseTlsDir" -}}/etc/postgresql/tls{{- end }}

{{/*
Every name the coordinator's leader Service answers to, which is what the server
certificate has to carry for `verify-full` to pass.

The short name is the one the connection string uses and the only one that
strictly has to be here; the qualified forms are here because an operator
reaching the same database with `psql` from another namespace writes one of
those, and a certificate that refuses them reads as a broken cluster rather than
as a name that was never promised.

A worker's own name is deliberately absent. Nothing connects to a worker by
name: Citus reaches them by pod address, which no certificate can promise in
advance, and that path is verified by CA rather than by name — see
`citus.node_conninfo` in database-config.yaml.
*/}}
{{- define "simple-balance.databaseCertNames" -}}
{{- $leader := include "simple-balance.databaseGroupName" (dict "root" . "group" 0) -}}
{{- $names := list $leader (printf "%s.%s" $leader .Release.Namespace) (printf "%s.%s.svc" $leader .Release.Namespace) (printf "%s.%s.svc.cluster.local" $leader .Release.Namespace) -}}
{{- toJson $names -}}
{{- end }}

{{/*
The CA and the server certificate, decided once per render and kept across
upgrades, for the same three reasons the passwords beside them are — with one
more that is specific to a certificate.

`genCA` and `genSignedCert` answer differently every time they are called. Called
from the Secret and again from the StatefulSet that mounts it, the two would not
match, and PostgreSQL would start with a key that does not belong to its
certificate. Called again on the next `helm upgrade`, a perfectly healthy
cluster would roll every database pod onto a new identity and every API pod onto
a new CA, for no reason anybody asked for.

So: an operator's own material wins, then whatever is already in the cluster's
Secret, then a generated pair. Under `helm template` there is no cluster to look
in, so a render always generates — which is why nothing here may be compared
across two renders and called a change.

The CA's private key is deliberately **not** kept. Nothing reads it after this:
the chart signs once and then holds the result, so storing it would be a
credential with no consumer sitting next to the superuser password. Rotation is
therefore "delete the four tls keys from the Secret and upgrade", which mints a
new CA and a new certificate together and rolls both tiers onto them —
`docs/citus-runbook.md` has the procedure.
*/}}
{{- define "simple-balance.databaseCertificates" -}}
{{- if not (hasKey .Values.database "resolvedTls") -}}
  {{- $tls := .Values.database.tls | default dict -}}
  {{- $resolved := dict -}}
  {{- if or $tls.ca $tls.cert $tls.key -}}
    {{- if not (and $tls.ca $tls.cert $tls.key) -}}
      {{- fail "database.tls takes ca, cert and key together or not at all. Half a certificate is a database that starts without TLS while the application insists on it." -}}
    {{- end -}}
    {{- $resolved = dict "ca" $tls.ca "cert" $tls.cert "key" $tls.key -}}
  {{- else -}}
    {{- $existing := (lookup "v1" "Secret" .Release.Namespace (include "simple-balance.databaseSecretName" .)) -}}
    {{- $data := dict -}}
    {{- if $existing -}}
      {{- $data = (default dict $existing.data) -}}
    {{- end -}}
    {{- if and (hasKey $data "ca.crt") (hasKey $data "tls.crt") (hasKey $data "tls.key") -}}
      {{- $resolved = dict "ca" (index $data "ca.crt" | b64dec) "cert" (index $data "tls.crt" | b64dec) "key" (index $data "tls.key" | b64dec) -}}
    {{- else -}}
      {{- $ca := genCA (printf "%s database CA" (include "simple-balance.databaseName" .)) 3650 -}}
      {{/*
      3650 days, and long on purpose. A chart cannot renew a certificate — it
      only runs when somebody runs it — so a short life is an outage scheduled
      for a date nobody wrote down, and every consumer of this CA is inside one
      namespace rather than on the public internet.
      */}}
      {{- $cert := genSignedCert (index (fromJsonArray (include "simple-balance.databaseCertNames" .)) 0) (list) (fromJsonArray (include "simple-balance.databaseCertNames" .)) 3650 $ca -}}
      {{- $resolved = dict "ca" $ca.Cert "cert" $cert.Cert "key" $cert.Key -}}
    {{- end -}}
  {{- end -}}
  {{- $_ := set .Values.database "resolvedTls" $resolved -}}
{{- end -}}
{{- end }}

{{- define "simple-balance.databaseCaCert" -}}
{{- include "simple-balance.databaseCertificates" . -}}
{{- .Values.database.resolvedTls.ca -}}
{{- end }}

{{- define "simple-balance.databaseServerCert" -}}
{{- include "simple-balance.databaseCertificates" . -}}
{{- .Values.database.resolvedTls.cert -}}
{{- end }}

{{- define "simple-balance.databaseServerKey" -}}
{{- include "simple-balance.databaseCertificates" . -}}
{{- .Values.database.resolvedTls.key -}}
{{- end }}

{{/*
Whether commits actually wait for a standby, as opposed to whether somebody
asked them to. `validate` refuses the contradiction outright, so this can only
differ from the setting if a future path reaches the config without passing
through the guard — which is exactly the case worth keeping honest, because the
half that would be wrong is the one that claims a guarantee.
*/}}
{{- define "simple-balance.databaseSynchronous" -}}
{{- if and .Values.database.synchronousReplication (gt (int .Values.database.replicasPerGroup) 1) }}true{{ end -}}
{{- end }}

{{/*
The four database passwords, decided once per render and kept across upgrades.

Three things have to be true at once and none of them is the default behavior.
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
  {{- range $role := (list "superuser" "replication" "application" "restapi") -}}
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
The fourth, and the only one that is not a PostgreSQL role. Patroni's REST API
is how a cluster is failed over, switched over, restarted and reinitialized, and
it listens on every interface in the pod. Without this any workload that can
open a socket in the namespace can promote a standby over a live primary. The
read-only endpoints — /liveness, /readiness and the health views — stay open,
which is what keeps the kubelet's probes working; Patroni only demands
credentials for the methods that change something.
*/}}
{{- define "simple-balance.databaseRestApiPassword" -}}
{{- include "simple-balance.databaseCredentials" . -}}
{{- .Values.database.resolvedPasswords.restapi -}}
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
