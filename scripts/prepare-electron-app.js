import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function assertExists(filePath, message) {
  try {
    await access(filePath);
  } catch {
    throw new Error(message ?? `Missing required file: ${filePath}`);
  }
}

function resolveStageDir(rootDir, stageDir) {
  return path.isAbsolute(stageDir) ? stageDir : path.join(rootDir, stageDir);
}

export async function prepareElectronApp({ rootDir = process.cwd(), stageDir = '.electron-build/app' } = {}) {
  const absoluteRoot = path.resolve(rootDir);
  const absoluteStage = resolveStageDir(absoluteRoot, stageDir);
  const distDir = path.join(absoluteRoot, 'dist');
  const toolHtml = path.join(distDir, 'tool.html');

  await assertExists(toolHtml, `Missing ${path.join('dist', 'tool.html')}. Run npm run electron:build-renderer first.`);

  const electronFiles = ['main.js', 'preload.cjs', 'protocol.js', 'webnn-features.js'];
  for (const fileName of electronFiles) {
    await assertExists(path.join(absoluteRoot, 'electron', fileName));
  }

  const rootPackage = JSON.parse(await readFile(path.join(absoluteRoot, 'package.json'), 'utf8'));

  await rm(absoluteStage, { recursive: true, force: true });
  await mkdir(absoluteStage, { recursive: true });

  await cp(distDir, path.join(absoluteStage, 'dist'), { recursive: true });
  for (const fileName of electronFiles) {
    await cp(path.join(absoluteRoot, 'electron', fileName), path.join(absoluteStage, fileName));
  }

  const stagedPackage = {
    name: 'pii-tools-desktop',
    productName: 'pii.tools',
    version: rootPackage.version,
    description: 'Browser-based PII anonymizer for Polish legal documents.',
    license: 'Apache-2.0',
    type: 'module',
    main: 'main.js',
    dependencies: {},
  };

  await writeFile(
    path.join(absoluteStage, 'package.json'),
    `${JSON.stringify(stagedPackage, null, 2)}\n`,
  );

  return absoluteStage;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await prepareElectronApp();
}
