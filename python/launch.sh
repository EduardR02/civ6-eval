#!/bin/sh
# This PID is emitted by the trusted launcher before the sandbox can run code.
printf '{"type":"sandbox","pid":%s}\n' "$$"
exec /usr/bin/bwrap "$@"
