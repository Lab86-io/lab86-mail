# Collabora CODE: bounded feasibility review

2026-09-10. Read-only review; no Railway provisioning or license purchase.

## Decision

CODE is a credible **synthetic staging pilot**, not yet an accepted public
production editor. Two independent gates remain: prove document isolation on
Railway without disabling security, and clarify the CODE binary terms for a
public multi-user Albatross service. This is an engineering assessment, not a
legal opinion.

## Licensing evidence

- The vendor calls CODE free for testing, home use and small teams, with no
  supported-production recommendation. Its FAQ distinguishes the rolling,
  unsupported CODE build from the subscribed stable product. That supports
  a personal/synthetic pilot; it is not an SLA or a blanket SaaS grant.
  [CODE](https://www.collaboraonline.com/code/),
  [FAQ](https://www.collaboraonline.com/faqs/).
- The separate licensing page says source is primarily MPL2, while executable
  forms have additional proprietary terms. The commercial EULA discusses
  subscription entitlements and a 30-day evaluation. Do not automatically
  apply that commercial evaluation period to CODE, or assume the source
  license alone resolves every binary entitlement.
  [License overview](https://www.collaboraonline.com/terms/collabora-online-mplv2/),
  [commercial EULA](https://www.collaboraonline.com/end-user-license-and-subscription-agreement/).
- The inspected official CODE image's `/usr/share/doc/coolwsd/copyright`
  identifies MPL-2. Its `/opt/collaboraoffice/LICENSE` identifies MPL2 and
  third-party licenses; no subscription or evaluation paragraph was found
  there. This is useful artifact-specific evidence, but does not eliminate
  the public terms ambiguity for a hosted service accepting other people's
  documents. The official image description targets home users.
  [Official image](https://hub.docker.com/r/collabora/code).
- Keep upstream notices/branding intact; modifying or redistributing branded
  builds raises separate trademark constraints.
  [Trademark policy](https://www.collaboraonline.com/trademark-policy/).

Before enabling a public production service, obtain CODE-specific written
confirmation of the intended hosted use or choose a source-built distribution
with reviewed notices and trademark compliance. Do not purchase anything on
the user's behalf. Do not repeat old “10 documents/20 connections” claims as a
current contractual cap without checking the pinned build and applicable terms.

## Exact image inspected

`collabora/code@sha256:cd75f5b95a01ec70ab5a1ca540b0b52e9fb0fea2146ca7210cb2488589b7fd6b`

Image metadata: CODE **26.04.3.2**, user **1001**, direct entrypoint
`/usr/bin/coolwsd --use-env-vars` with image-specific template/cache paths.
It is distroless: `/bin/sh` is absent. A stopped, network-disabled, read-only
container was created solely to inspect image files; no server or documents
were started by this reviewer.

Do not override the start command with `sh -c`. The binary itself understands
`extra_params` under `--use-env-vars`.
[Pinned server source](https://github.com/CollaboraOnline/online.mirror/blob/cp-26.04.3-2/wsd/COOLWSD.cpp).

## Isolation gate

The pinned config defaults to `security.capabilities=true`,
`security.seccomp=true`, and `security.enable_macros_execution=false`.
Keep these defaults. Upstream supports per-document jails and system-call
filtering; its Helm chart documents an unprivileged, zero-capability setup
**with a host-installed custom seccomp profile**.
[Security overview](https://www.collaboraonline.com/security/),
[upstream Helm configuration](https://github.com/CollaboraOnline/online/blob/main/kubernetes/helm/collabora-online/values.yaml).

Crucially, in the pinned 26.04.3.2 source,
`security.capabilities=false` selects `NoCapsForKit` and disables mount
namespaces. Landlock code exists, but its presence alone does not prove an
equivalent, enforced sandbox on Railway. Never silently add that flag or
`security.seccomp=false` merely to make the editor start.
[Pinned startup logic](https://github.com/CollaboraOnline/online.mirror/blob/cp-26.04.3-2/wsd/COOLWSD.cpp#L2112),
[pinned process checks](https://github.com/CollaboraOnline/online.mirror/blob/cp-26.04.3-2/kit/ForKit.cpp#L968).

Railway's official docs describe its containers as non-privileged. No
documented service-level custom seccomp/capability configuration was found in
the complete current docs export. Community OpenCloud/Filestash templates
are evidence that others attempt this deployment, not proof of retained
per-document isolation or licensing suitability.
[Railway documentation export](https://docs.railway.com/api/llms-docs.md),
[OpenCloud template](https://railway.com/deploy/opencloud-drive),
[Filestash template](https://railway.com/deploy/filestash-collabora).

Pilot acceptance must include actual DOCX/XLSX/PPTX open/edit/save/reopen and
startup/child-process isolation evidence. Check namespace/jail establishment,
seccomp installation and absence of insecure-fallback warnings. Discovery
XML or a healthcheck returning 200 is insufficient. If Railway cannot retain
the required isolation, do not enable real-document processing there; report
that platform gate instead of weakening security. A separate supported host
would require an explicit infrastructure decision.

## Deployment shape and budget (conditional)

If the gates pass: one pinned editor service per environment, port 9980,
Railway TLS termination, exact environment-specific WOPI host allowlist and
frame-ancestor policy, no public admin/metrics surface, short-lived scoped WOPI
tokens and compare-and-swap saves. No shared staging/production document
credentials or token signing keys.

Current Railway usage pricing is $10/GB-month memory, $20/vCPU-month CPU,
and $0.05/GB egress. Two services each averaging 2GB RAM and 0.25 vCPU would
therefore add about **$50/month plus egress**; this is arithmetic, not a
measurement or guarantee. Measure synthetic concurrency and use resource
limits/budget alerts before claiming the user's <$100/month requirement.
[Railway pricing](https://docs.railway.com/pricing/plans#resource-usage-pricing).
