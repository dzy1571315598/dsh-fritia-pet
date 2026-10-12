@echo off
rem Publish or update this plugin on GitHub without git (REST API only).
rem Token: %GITHUB_TOKEN%, or ../mcp/token.txt.
setlocal
node "%~dp0publish-github.mjs" %*
