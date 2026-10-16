@echo off
rem The fixture ACP agent as a Harness launcher for Windows, twin of fixture-harness.sh.
rem Preflight runs `<launcher> --version`, which the Rust test binary rejects.
rem Usage: fixture-harness.cmd <fidget test binary> script=<name> [count=<file>]
rem %* keeps script= and count= whole; cmd would split %2 at the equals sign.
rem libtest takes them as extra filters, which --exact matches to nothing.
if "%~1"=="--version" (
  echo fixture-harness
  exit /b 0
)
%* harness::tests::fake_acp_agent --exact --nocapture --test-threads=1
