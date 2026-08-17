@echo off
rem Scheduled-task entry for scheduler.mjs (invoked by Task Scheduler every minute).
rem Change dir to the script's own folder so relative paths resolve correctly.
cd /d "%~dp0"
node scheduler.mjs check
