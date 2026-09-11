import { describe, expect, it } from 'vitest'
import { isFilled, isHttpUrl, isPrivateHost, isInsecureHttpUrl, removeTrailingSlashes } from './validators.js'

describe('isFilled', () => {
	it('detects empty and filled values', () => {
		expect(isFilled('')).toBe(false)
		expect(isFilled(null)).toBe(false)
		expect(isFilled(undefined)).toBe(false)
		expect(isFilled('x')).toBe(true)
	})
})

describe('isHttpUrl', () => {
	it('accepts http and https schemes only', () => {
		expect(isHttpUrl('http://example.com')).toBe(true)
		expect(isHttpUrl('https://example.com')).toBe(true)
		expect(isHttpUrl('ftp://example.com')).toBe(false)
		expect(isHttpUrl('example.com')).toBe(false)
	})
})

describe('removeTrailingSlashes (Bubka/2FAuth#565)', () => {
	it('strips one or more trailing slashes', () => {
		expect(removeTrailingSlashes('https://vault.example.com/')).toBe('https://vault.example.com')
		expect(removeTrailingSlashes('https://vault.example.com///')).toBe('https://vault.example.com')
	})

	it('leaves URLs without a trailing slash unchanged', () => {
		expect(removeTrailingSlashes('https://vault.example.com')).toBe('https://vault.example.com')
	})

	it('preserves path-internal slashes (subfolder installs)', () => {
		expect(removeTrailingSlashes('https://vault.example.com/2fauth/')).toBe('https://vault.example.com/2fauth')
		expect(removeTrailingSlashes('https://vault.example.com/2fauth')).toBe('https://vault.example.com/2fauth')
	})
})

describe('isPrivateHost (D17/RT8)', () => {
	it('accepts localhost, loopback, RFC1918 and link-local hosts', () => {
		expect(isPrivateHost('localhost')).toBe(true)
		expect(isPrivateHost('app.localhost')).toBe(true)
		expect(isPrivateHost('127.0.0.1')).toBe(true)
		expect(isPrivateHost('10.0.0.5')).toBe(true)
		expect(isPrivateHost('172.16.1.1')).toBe(true)
		expect(isPrivateHost('172.31.255.255')).toBe(true)
		expect(isPrivateHost('192.168.1.10')).toBe(true)
		expect(isPrivateHost('169.254.3.4')).toBe(true)
		expect(isPrivateHost('::1')).toBe(true)
	})

	it('rejects public hosts', () => {
		expect(isPrivateHost('example.com')).toBe(false)
		expect(isPrivateHost('172.32.0.1')).toBe(false)
		expect(isPrivateHost('172.15.0.1')).toBe(false)
		expect(isPrivateHost('8.8.8.8')).toBe(false)
		expect(isPrivateHost('')).toBe(false)
	})
})

describe('isInsecureHttpUrl (D17/RT8)', () => {
	it('rejects plain http to public hosts', () => {
		expect(isInsecureHttpUrl('http://2fauth.example.com')).toBe(true)
		expect(isInsecureHttpUrl('http://8.8.8.8')).toBe(true)
	})

	it('allows plain http to local/private hosts', () => {
		expect(isInsecureHttpUrl('http://localhost:8000')).toBe(false)
		expect(isInsecureHttpUrl('http://127.0.0.1')).toBe(false)
		expect(isInsecureHttpUrl('http://192.168.1.10:8080')).toBe(false)
		expect(isInsecureHttpUrl('http://10.0.0.5/2fauth')).toBe(false)
	})

	it('ignores https URLs and non-http values', () => {
		expect(isInsecureHttpUrl('https://example.com')).toBe(false)
		expect(isInsecureHttpUrl('https://localhost')).toBe(false)
		expect(isInsecureHttpUrl('example.com')).toBe(false)
		expect(isInsecureHttpUrl('http://not a url')).toBe(true)
	})
})
