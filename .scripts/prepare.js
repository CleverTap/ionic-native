/**
 * Deploy script adopted from https://github.com/sindresorhus/np
 * MIT License (c) Sindre Sorhus (sindresorhus.com)
 */
const chalk = require('chalk');
const execa = require('execa');
const inquirer = require('inquirer');
const Listr = require('listr');
const fs = require('fs-extra');
const semver = require('semver');
const common = require('./common');
const path = require('path');


async function main() {
  try {
    if (!process.env.GH_TOKEN) {
      throw new Error('env.GH_TOKEN is undefined');
    }

    const version = await askVersion();

    // compile and verify packages
    await preparePackages(common.packages, version);

    console.log(`\nionic ${version} prepared 🤖\n`);
    console.log(`Next steps:`);
    console.log(`  Verify CHANGELOG.md`);
    console.log(`  git commit -m "${version}"`);
    console.log(`  npm run release\n`);

  } catch(err) {
    console.log('\n', chalk.red(err), '\n');
    process.exit(1);
  }
}


async function askVersion() {
  const pkg = common.readPkg('core');
  const oldVersion = pkg.version;

  const prompts = [
    {
      type: 'list',
      name: 'version',
      message: 'Select semver increment or specify new version',
      pageSize: SEMVER_INCREMENTS.length + 2,
      choices: SEMVER_INCREMENTS
        .map(inc => ({
          name: `${inc}   ${prettyVersionDiff(oldVersion, inc)}`,
          value: inc
        }))
        .concat([
          new inquirer.Separator(),
          {
            name: 'Other (specify)',
            value: null
          }
        ]),
      filter: input => isValidVersionInput(input) ? getNewVersion(oldVersion, input) : input
    },
    {
      type: 'input',
      name: 'version',
      message: 'Version',
      when: answers => !answers.version,
      filter: input => isValidVersionInput(input) ? getNewVersion(pkg.version, input) : input,
      validate: input => {
        if (!isValidVersionInput(input)) {
          return 'Please specify a valid semver, for example, `1.2.3`. See http://semver.org';
        } else if (!common.isVersionGreater(oldVersion, input)) {
          return `Version must be greater than ${oldVersion}`;
        }

        return true;
      }
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: answers => {
        return `Will bump from ${chalk.cyan(oldVersion)} to ${chalk.cyan(answers.version)}. Continue?`;
      }
    }
  ];

  const {version} = await inquirer.prompt(prompts);
  return version;
}


async function preparePackages(packages, version) {
  // execution order matters
  const tasks = [];

  // check git is nice and clean local and remote
  common.checkGit(tasks);

  // test we're good with git
  validateGit(tasks, version);

  // add all the prepare scripts
  // run all these tasks before updating package.json version
  packages.forEach(package => {
    common.preparePackage(tasks, package, version);
  });

  // add update package.json of each project
  packages.forEach(package => {
    updatePackageVersion(tasks, package, version);
  });

  // generate changelog
  generateChangeLog(tasks);

  // update core readme with version number
  updateCoreReadme(tasks, version);

  const listr = new Listr(tasks, { showSubtasks: true });
  await listr.run();
}


function validateGit(tasks, version) {
  tasks.push(
    {
      title: `Validate git tag ${chalk.dim(`(v${version})`)}`,
      task: () => execa('git', ['fetch'])
        .then(() => {
          return execa.stdout('npm', ['config', 'get', 'tag-version-prefix']);
        })
        .then(
          output => {
            tagPrefix = output;
          },
          () => {}
        )
        .then(() => execa.stdout('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tagPrefix}${version}`]))
        .then(
          output => {
            if (output) {
              throw new Error(`Git tag \`${tagPrefix}${version}\` already exists.`);
            }
          },
          err => {
            // Command fails with code 1 and no output if the tag does not exist, even though `--quiet` is provided
            // https://github.com/sindresorhus/np/pull/73#discussion_r72385685
            if (err.stdout !== '' || err.stderr !== '') {
              throw err;
            }
          }
        )
    },
  );
}

function updatePackageVersion(tasks, package, version) {
  const projectRoot = common.projectPath(package);
  const pkg = common.readPkg(package);

  tasks.push(
    {
      title: `${pkg.name}: update package.json ${chalk.dim(`(${version})`)}`,
      task: async () => {
        await execa('npm', ['version', version], { cwd: projectRoot });

        const pkgLock = path.join(projectRoot, 'package-lock.json');
        const pkgLockData = JSON.parse(fs.readFileSync(pkgLock, 'utf-8'));
        pkgLockData.version = version;

        fs.writeFileSync(pkgLock, JSON.stringify(pkgLockData, null, 2));
      }
    }
  );
}


function generateChangeLog(tasks) {
  tasks.push({
    title: `Generate CHANGELOG.md`,
    task: () => execa('npm', ['run', 'changelog'], { cwd: common.rootDir }),
  });
}


function updateCoreReadme(tasks, version) {
  tasks.push({
    title: `Update core README.md`,
    task: () => execa('node', ['update-readme.js', version], { cwd: path.join(common.rootDir, 'core', 'scripts') }),
  });
}


const SEMVER_INCREMENTS = ['patch', 'minor', 'major'];

const isValidVersionInput = input => SEMVER_INCREMENTS.indexOf(input) !== -1 || common.isValidVersion(input);

function getNewVersion(oldVersion, input) {
  if (!isValidVersionInput(input)) {
    throw new Error(`Version should be either ${SEMVER_INCREMENTS.join(', ')} or a valid semver version.`);
  }

  return SEMVER_INCREMENTS.indexOf(input) === -1 ? input : semver.inc(oldVersion, input);
};


function prettyVersionDiff(oldVersion, inc) {
  const newVersion = getNewVersion(oldVersion, inc).split('.');
  oldVersion = oldVersion.split('.');
  let firstVersionChange = false;
  const output = [];

  for (let i = 0; i < newVersion.length; i++) {
    if ((newVersion[i] !== oldVersion[i] && !firstVersionChange)) {
      output.push(`${chalk.dim.cyan(newVersion[i])}`);
      firstVersionChange = true;
    } else if (newVersion[i].indexOf('-') >= 1) {
      let preVersion = [];
      preVersion = newVersion[i].split('-');
      output.push(`${chalk.dim.cyan(`${preVersion[0]}-${preVersion[1]}`)}`);
    } else {
      output.push(chalk.reset.dim(newVersion[i]));
    }
  }
  return output.join(chalk.reset.dim('.'));
}

main();