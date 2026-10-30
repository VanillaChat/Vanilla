#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
if ! byteorm --schema-dir /app/byteorm --output "$work_dir/generated" push \
    >"$work_dir/stdout" 2>"$work_dir/stderr"; then
    cat "$work_dir/stdout"
    cat "$work_dir/stderr" >&2
    exit 1
fi
cat "$work_dir/stdout"
if [ -s "$work_dir/stderr" ] || ! grep -q '^Push complete!$' "$work_dir/stdout"; then
    cat "$work_dir/stderr" >&2
    echo 'Schema migration failed; backend startup is blocked.' >&2
    exit 1
fi
