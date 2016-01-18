#!/usr/bin/env node
'use strict'

const request = require('axios')
const path = require('path')
const uri = require('lil-uri')
const fs = require('fs')
const program = require('commander')
const prompt = require('co-prompt')
const co = require('co')
const chalk = require('chalk')
const assert = require('assert')

const DEFAULT_FILE = 'CHANGES.md'
const JIRA_REGEX = /(?:)([A-Z]{1,}-[0-9]+)(?=\s|_|$)/g

let settings

program
	.option('-o, --overwrite', 'regenerate the full changelog. OVERWRITES the current changelog')
	.option('-i, --interactive', 'request username / password if not provided')
	.parse(process.argv)

co(function *() {
	settings = yield getSettings(program)
	const releases = yield buildReleases()
	const contents = renderReleases(releases)
	write(settings.file, contents)
	complete()
})
.catch(e => error(e))

function *getSettings(program) {
	const repoInfo = getRepoInfo()
	const pkgInfo = getPackageInfo()
	const settings = Object.assign({}, repoInfo, pkgInfo)

	const user = settings.username = process.env.BITBUCKET_USER
	if (!user && program.interactive) settings.username = yield prompt('username: ')

	const pswd = settings.password = process.env.BITBUCKET_PSWD
	if (!pswd && program.interactive) settings.password = yield prompt.password('password: ')

	if (!settings.slug) settings.slug = path.basename(process.cwd())
	if (!settings.basePath) settings.basePath = '/rest/api/1.0/projects'

	settings.overwrite = !!program.overwrite
	settings.file = settings.file ? path.resolve(settings.file) : path.resolve(DEFAULT_FILE)
	settings.baseUrl = `${settings.bitbucket}${settings.basePath}/${settings.projectKey}/repos/${settings.slug}`
	settings.fileContents = read(settings.file)

	verifySettings(settings)

	return settings
}

function verifySettings(settings) {
	assert.ok(settings.version, `Could not determine release version number. Is your package.json present?`)
	assert.ok(settings.username, 'Please define username via `BITBUCKET_USER` env variable, or run in interactive mode.')
	assert.ok(settings.password, 'Please define password via `BITBUCKET_PSWD` env variable, or run in interactive mode.')
	assert.ok(settings.bitbucket, 'Please define your bitbucket base url in package.json. See README for more info.')

	if (!settings.overwrite) {
		const releaseTitle = renderReleaseTitle({version: settings.version})
		const regex = new RegExp(`^${releaseTitle}$`, 'm')
		const present = settings.fileContents.match(regex)
		assert.ok(!present, `Release ${settings.version} was already found in changelog. Aborting.`)
	}
}

function getRepoInfo() {
	try {
		const gitConfig = fs.readFileSync(path.resolve('.git/config'), 'utf8')
		const match = gitConfig.match(/(https:|ssh:).+\.git$/m)
		const url = uri(match[0])
		let host = url.host()
		const i = host.lastIndexOf(':')
		if (i != -1) host = host.substr(0, i)
		const parts = url.path().split('/')
		const slug = path.basename(parts.pop(), '.git')
		const key = parts.pop()
		return {bitbucket: `https://${host}`, projectKey: key, slug}
	}
	catch(e) { }
	return {}
}

function getPackageInfo() {
	try {
		const pkg = require(path.resolve('./package.json'))
		return Object.assign({version: pkg.version}, pkg.changelog)
	}
	catch(e) {
		return {}
	}
}

function getPullRequests(branch, state, since, start, size, results) {
	return getPullRequestsPage(branch, state, start, size).then(res => {
		let prs = res.values
		if (since) {
			prs = prs.filter(pr => pr.updatedDate > since)
		}
		results = (results || []).concat(prs)
		if (res.isLastPage || prs.length < res.values.length) {
			return results.filter(pr => pr.toRef.id === `refs/heads/${branch}`)
		} else {
			return getPullRequests(branch, state, since, start + size, size, results)
		}
	})
}

function getPullRequestsPage(branch, state, start, size) {
	return serviceCall(`${settings.baseUrl}/pull-requests?state=${state}&order=NEWEST&at=refs/heads/${branch}&start=${start}&limit=${size}`)
}

function getTags(start, size, max, tags) {
	return getTagsPage(start, size).then(res => {
		tags = (tags || []).concat(res.values)
		if (res.isLastPage || (max && tags.length >= max)) {
			return tags
		} else {
			return getTags(start + 1, size, max, tags)
		}
	})
}

function getTagsPage(start, size) {
	return serviceCall(`${settings.baseUrl}/tags?start=${start}&limit=${size}`)
}

function getCommit(hash) {
	return serviceCall(`${settings.baseUrl}/commits/${hash}`)
}

function serviceCall(url) {
	return request({
		url,
		headers: {
			accept: 'application/json'
		},
		auth: {
			username: settings.username,
			password:  settings.password
		},
		responseType: 'json'
	})
	.then(res => res.data)
}

function *buildReleases() {
	const maxTags = settings.overwrite ? 0 : 1 // get all tags if overwriting
	const tags = yield getTags(0, 25, maxTags)

	const tagCommitPromises = tags.map(tag => getCommit(tag.hash))
	const tagCommits = yield tagCommitPromises
	tags.forEach((tag, i) => tag.commit = tagCommits[i])

	const since = settings.overwrite ? null : tags[0].commit.authorTimestamp
	const prs = yield getPullRequests('master', 'MERGED', since, 0, 50)

	const childPrPromises = prs.map(pr => getPullRequests(pr.fromRef.displayId, 'MERGED', null, 0, 25))
	const childPrs = yield childPrPromises
	prs.forEach((pr, i) => pr.children = childPrs[i])

	let release = {version: settings.version, prs: []}
	let lastTag = tags.shift()
	const releases = []
	while (prs.length) {
		const pr = prs.shift()
		if (!lastTag || (pr.updatedDate > lastTag.commit.authorTimestamp)) {
			release.prs.push(pr)
		} else {
			releases.push(release)
			release = {prs: [pr]}
			if (lastTag) release.version = lastTag.displayId
			lastTag = tags.shift()
		}
	}
	if (releases[releases.length - 1] !== release) {
		releases.push(release)
	}
	return releases
}

function renderReleases(releases) {
	return releases
		.map(r => renderRelease(r))
		.reduce((all, lines) => all.concat(lines), [])
		.join('\n') + '\n'
}

function renderRelease(r) {
	let lines = []
	lines.push(renderReleaseTitle(r))
	lines = lines.concat(renderPrs(r.prs, 0))
	lines.push('')
	return lines
}

function renderReleaseTitle(release) {
	return `## ${release.version}`
}

function renderPrs(prs, indent) {
	return prs.map(pr => renderPr(pr, indent))
		.reduce((all, lines) => all.concat(lines), [])
}

function renderPr(pr, indent) {
	const space = ' '.repeat(indent)
	let lines = []
	lines.push(`${space}- ${renderPrLink(pr)} ${pr.title} <small>${renderAuthor(pr)}${renderJiras(pr)}</small>`)
	if (pr.children && pr.children.length) {
		lines = lines.concat(renderPrs(pr.children, indent + 4))
	}
	return lines
}

function renderPrLink(pr) {
	return `[${pr.id}](${pr.links.self[0].href})`
}

function renderAuthor(pr) {
	return `[${pr.author.user.displayName}](${pr.author.user.links.self[0].href})`
}

function renderJiras(pr) {
	const m1 = (pr.title || '').match(JIRA_REGEX)
	const m2 = (pr.description || '').match(JIRA_REGEX)
	const m3 = (pr.fromRef.displayId || '').match(JIRA_REGEX)
	const comb = (m1 || []).concat(m2 ||[]).concat(m3 || [])
	const jiras = [...new Set(comb)]
	if (jiras.length) {
		if (settings.jira) {
			return ` (${jiras.map(id => `[${id}](${settings.jira}/browse/${id})`).join(', ')})`
		} else {
			return ` (${jiras.join(', ')})`
		}
	} else {
		return ''
	}
}

function read(file) {
	return stats(file) ? fs.readFileSync(file, 'utf8') : ''
}

function write(file, contents) {
	const fileStats = stats(file)
	if (settings.overwrite || !fileStats) {
		fs.writeFileSync(file, contents, 'utf8')
	} else {
		fs.writeFileSync(file, settings.fileContents + oldContents, 'utf8')
	}
}

function stats(file) {
	try {
		return !!fs.statSync(file)
	} catch(e) {
		return null
	}
}

function complete() {
	const filename = path.basename(settings.file)
	const msg = `${settings.version} written to ${filename}`
	console.log(chalk.bold.cyan(msg))
}

function error(e) {
	let msg
	if (e.status) msg = `${res.status}: ${res.statusText} - ${res.data}`
	else if (e.message) msg = e.message
	else msg = e

	console.log(chalk.red(msg))
	process.exist(1)
}
