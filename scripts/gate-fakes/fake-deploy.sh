#!/usr/bin/env bash
# A zero-spend stand-in for a real deployment, for `scripts/gate-m52-broker.mjs`.
#
# The FOURTH fake in this directory and the first that is not a vendor-CLI stand-in: the other three
# pretend to be a worker, and this pretends to be the thing a worker is not allowed to touch. It is
# what a `BrokerBinding.command` points at, so the gate can prove the whole path -- a worker naming
# an operation, the orchestrator resolving a credential the worker cannot see, and something on the
# far side receiving it -- without a remote, a cloud account or a secret that is worth anything.
#
# It records ONE line per invocation into its log:
#
#     <environment>|<digest>|token-present:<yes|no>
#
# and never the token's VALUE. A fake that printed the secret it was given would put that secret in
# the gate's own log, in CI, and the one thing this milestone is about is that a secret goes exactly
# one place. `token-present` is the assertion the gate actually needs: the credential reached THIS
# child, and (asserted on the other side, from the child env dump the fake CLI writes) did not reach
# the worker's.
#
# WHERE EACH OF ITS THREE INPUTS COMES FROM IS THE POINT, and each comes from a different place
# because `realBrokerExecutor` (`packages/control/src/broker.ts`) gives a brokered child EXACTLY
# three things and nothing else -- `PATH`, the one credential the binding names, and one
# `SLAVEOFAI_BROKER_PARAM_<NAME>` per parameter:
#
#   - the credential, `FAKE_DEPLOY_TOKEN`, from the ENVIRONMENT. It is there because a person bound
#     this operation to a `Credential` row naming that variable, and it is read off the ORCHESTRATOR's
#     own environment at execution time -- never the worker's.
#   - the parameters, `SLAVEOFAI_BROKER_PARAM_ENVIRONMENT` and `SLAVEOFAI_BROKER_PARAM_DIGEST`, from
#     the ENVIRONMENT too, and never from argv: a parameter that entered the command line would be a
#     quoting question, and this way it is not one.
#   - the log path, `--log <path>`, from ARGV -- because a brokered child's environment is the three
#     things above and NOTHING the daemon holds, so a `FAKE_DEPLOY_LOG` exported beside the daemon
#     does not arrive here. Argv is `BrokerBinding.command`, which is a row a person wrote, which is
#     exactly where a deployment's own configuration belongs. `FAKE_DEPLOY_LOG` is still read first,
#     for a person running this script by hand.
set -uo pipefail

log="${FAKE_DEPLOY_LOG:-}"
prev=''
for arg in "$@"; do
  if [ "$prev" = '--log' ]; then log="$arg"; fi
  prev="$arg"
done

# Loudly, and at a status no caller can mistake for the operation's own: `realBrokerExecutor` reports
# the child's exit code verbatim, so 0 would be "deployed" and 1 would be "the deploy failed". 3 is
# neither, and it says the FAKE is misconfigured rather than that the fake deployment went wrong.
if [ -z "$log" ]; then
  printf 'fake-deploy.sh: no log path -- pass `--log <path>` in the binding'"'"'s command (or set FAKE_DEPLOY_LOG when running this by hand). This fake exists to record that it ran, and with nowhere to record it there is nothing to prove.\n' >&2
  exit 3
fi

# `token-present`, never the token. The variable name is the one the `Credential` row registered, and
# whether it ARRIVED is the whole question.
token_present='no'
if [ -n "${FAKE_DEPLOY_TOKEN:-}" ]; then token_present='yes'; fi

printf '%s|%s|token-present:%s\n' \
  "${SLAVEOFAI_BROKER_PARAM_ENVIRONMENT:-}" "${SLAVEOFAI_BROKER_PARAM_DIGEST:-}" "$token_present" \
  >> "$log" || {
  printf 'fake-deploy.sh: could not append to %s\n' "$log" >&2
  exit 3
}

printf 'deployed\n'
exit 0
