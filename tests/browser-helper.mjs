import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
const edge = process.platform === 'win32' ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync) : undefined
export function launchBrowser() {
  return chromium.launch({ headless: true, executablePath: process.env.DSH_TEST_BROWSER || edge })
}
