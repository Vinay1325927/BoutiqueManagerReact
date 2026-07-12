import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()
const requirementsPath = path.join(root, 'requirements.txt')
const venvDir = path.join(root, '.venv')
const python = path.join(venvDir, 'bin', 'python')
const pip = path.join(venvDir, 'bin', 'pip')
const stampPath = path.join(venvDir, '.requirements.sha256')
const requirements = readFileSync(requirementsPath)
const expectedStamp = createHash('sha256').update(requirements).digest('hex')
const currentStamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : ''

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

if (!existsSync(python)) {
  console.log('Creating the local PDF-only Python environment…')
  run(process.env.SYSTEM_PYTHON || 'python3', ['-m', 'venv', venvDir])
}

if (currentStamp !== expectedStamp) {
  console.log('Installing passbook and billing Python packages…')
  run(pip, ['install', '--disable-pip-version-check', '-r', requirementsPath])
  mkdirSync(venvDir, { recursive: true })
  writeFileSync(stampPath, `${expectedStamp}\n`)
} else {
  console.log('Python PDF environment is ready.')
}
