#!/bin/sh
# Fail before accepting traffic if the installed certificate/include policy is
# invalid. Docker's restart policy retries; private operators inspect diagnostics.
set -eu
nginx -t -q
exec nginx -g 'daemon off;'
