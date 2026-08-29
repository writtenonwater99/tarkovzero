@echo off
REM TarkovZero Companion with a visible console (fallback for debugging).
REM Any extra arguments are passed through, e.g. start-companion.cmd --verbose
cd /d %~dp0
node companion.mjs %*
