# Evidence-only observer for the successful return of the existing attach guard.
# Never changes a command, return code, catalog, Runtime input, or acceptance rule.
# The helper normally captures and suppresses workspace attach's JSON; retain it
# at the success message, while its local attach_out and attach_rc still exist.
set -T
trap 'if [[ "${BASH_COMMAND:-}" == "_realm_say \"done: stack now selects"* && "${attach_rc:-missing}" == 0 && -n "${attach_out:-}" && -n "${P61_ATTACH_LOG:-}" && ! -e "$P61_ATTACH_LOG" ]]; then printf "%s\n" "$attach_out" > "$P61_ATTACH_LOG"; fi' DEBUG
