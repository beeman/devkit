/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import * as fs from 'fs';
import * as glob from 'glob';
import * as path from 'path';

import {packages} from '../lib/packages';

const minimatch = require('minimatch');
const npmRun = require('npm-run');

const gitIgnore = fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf-8')
  .split('\n')
  .map(line => line.replace(/#.*/, ''))
  .filter(line => !line.match(/^\s*$/));

function gitIgnoreMatch(p: string) {
  p = path.relative(path.dirname(__dirname), p);
  return gitIgnore.some(line => minimatch(p, line));
}


function mkdirp(p: string) {
  // Create parent folder if necessary.
  if (!fs.existsSync(path.dirname(p))) {
    mkdirp(path.dirname(p));
  }
  fs.mkdirSync(p);
}


function copy(from: string, to: string) {
  // Create parent folder if necessary.
  if (!fs.existsSync(path.dirname(to))) {
    mkdirp(path.dirname(to));
  }

  from = path.relative(process.cwd(), from);
  to = path.relative(process.cwd(), to);

  const buffer = fs.readFileSync(from);
  fs.writeFileSync(to, buffer);
}


function recursiveCopy(from: string, to: string) {
  if (!fs.existsSync(from)) {
    console.error(`File "${from}" does not exist.`);
    process.exit(4);
  }
  if (fs.statSync(from).isDirectory()) {
    fs.readdirSync(from).forEach(fileName => {
      recursiveCopy(path.join(from, fileName), path.join(to, fileName));
    });
  } else {
    copy(from, to);
  }
}


function rm(p: string) {
  p = path.relative(process.cwd(), p);
  fs.unlinkSync(p);
}


function rimraf(p: string) {
  glob.sync(path.join(p, '**/*'), { dot: true, nodir: true })
    .forEach(p => fs.unlinkSync(p));
  glob.sync(path.join(p, '**/*'), { dot: true })
    .sort((a, b) => b.length - a.length)
    .forEach(p => fs.rmdirSync(p));
}


export default function() {
  console.log('Removing dist/...');
  rimraf(path.join(__dirname, '../dist'));

  // Order packages in order of dependency.
  // We use bubble sort because we need a full topological sort but adding another dependency
  // or implementing a full topo sort would be too much work and I'm lazy. We don't anticipate
  // any large number of
  const sortedPackages = Object.keys(packages);
  let swapped = false;
  do {
    swapped = false;
    for (let i = 0; i < sortedPackages.length - 1; i++) {
      for (let j = i + 1; j < sortedPackages.length; j++) {
        const a = sortedPackages[i];
        const b = sortedPackages[j];

        if (packages[a].dependencies.indexOf(b) != -1) {
          // Swap them.
          [sortedPackages[i], sortedPackages[i + 1]]
            = [sortedPackages[i + 1], sortedPackages[i]];
          swapped = true;
        }
      }
    }
  } while (swapped);


  console.log('Building...');
  const tsConfigPath = path.relative(process.cwd(), path.join(__dirname, '../tsconfig.json'));
  try {
    npmRun.execSync(`tsc -p "${tsConfigPath}"`);
  } catch (err) {
    const stdout = err.stdout.toString().split('\n').join('\n  ');
    console.error(`TypeScript compiler failed:\n\nSTDOUT:\n  ${stdout}`);
    process.exit(1);
  }

  console.log('Moving packages to dist/');
  for (const packageName of sortedPackages) {
    console.log(`  ${packageName}`);
    const pkg = packages[packageName];
    recursiveCopy(pkg.build, pkg.dist);
    rimraf(pkg.build);
  }

  console.log('Copying resources...');
  for (const packageName of sortedPackages) {
    console.log(`  ${packageName}`);
    const pkg = packages[packageName];
    const pkgJson = pkg.packageJson;
    const files = glob.sync(path.join(pkg.root, '**/*'), { dot: true, nodir: true });
    console.log(`    ${files.length} files total...`);
    const resources = files
      .map((fileName) => path.relative(pkg.root, fileName))
      .filter(fileName => {
        // Schematics template files.
        if (pkgJson['schematics'] && fileName.match(/\/files\//)) {
          return true;
        }
        if (fileName.endsWith('package.json')) {
          return true;
        }

        // Remove Bazel files from NPM.
        if (fileName.endsWith('BUILD')) {
          return false;
        }

        // Skip sources.
        if (fileName.endsWith('.ts')) {
          // Verify that it was actually built.
          if (!fs.existsSync(path.join(pkg.dist, fileName).replace(/ts$/, 'js'))) {
            console.error(`\nSource found but compiled file not found: "${fileName}".`);
            process.exit(2);
          }
          // Skip all sources.
          return false;
        }

        // Skip tsconfig only.
        if (fileName.endsWith('tsconfig.json')) {
          return false;
        }

        // Skip files from gitignore.
        if (gitIgnoreMatch(fileName)) {
          return false;
        }

        return true;
      });

    console.log(`    ${resources.length} resources...`);
    resources.forEach(fileName => {
      copy(path.join(pkg.root, fileName), path.join(pkg.dist, fileName));
    });
  }

  console.log('Copying extra resources...');
  for (const packageName of sortedPackages) {
    const pkg = packages[packageName];
    copy(path.join(__dirname, '../LICENSE'), path.join(pkg.dist, 'LICENSE'));
  }

  console.log('Removing spec files...');
  for (const packageName of sortedPackages) {
    console.log(`  ${packageName}`);
    const pkg = packages[packageName];
    const files = glob.sync(path.join(pkg.dist, '**/*_spec.js'));
    console.log(`    ${files.length} spec files found...`);
    files.forEach(fileName => rm(fileName));
  }

  console.log('Setting versions...');

  const versions = require(path.join(__dirname, '../versions.json'));
  for (const packageName of sortedPackages) {
    console.log(`  ${packageName}`);
    const pkg = packages[packageName];
    const packageJsonPath = path.join(pkg.dist, 'package.json');
    const packageJson = pkg.packageJson;

    if (versions[packageName]) {
      packageJson['version'] = versions[packageName];
    } else {
      console.log('    No version found... Only updating dependencies.');
    }

    for (const depName of Object.keys(versions)) {
      const v = versions[depName];
      for (const depKey of ['dependencies', 'peerDependencies', 'devDependencies']) {
        if (packageJson[depKey] && packageJson[depKey][depName] == '0.0.0') {
          packageJson[depKey][depName] = v;
        }
      }
    }

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  }

  console.log(`Done.`);
}
