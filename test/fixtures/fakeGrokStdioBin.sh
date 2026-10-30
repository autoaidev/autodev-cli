#!/bin/sh
# Offline test stand-in for the `grok` binary. Only `grok agent --help` matters:
# grokAgentStdioSupported() runs it and checks the output for the word "stdio" to
# decide whether this grok build exposes the persistent ACP transport. Emitting a
# help text that contains "stdio" makes grokAcpEnabled() resolve TRUE deterministically
# in tests, with no real grok install and no network. Any other invocation is a no-op.
if [ "$1" = "agent" ]; then
  cat <<'EOF'
Usage: grok agent <COMMAND>

Commands:
  stdio   Start an ACP agent over stdio (persistent session)
  help    Print this message
EOF
  exit 0
fi
exit 0
