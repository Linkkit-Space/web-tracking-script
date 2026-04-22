/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { sign } from '@tsndr/cloudflare-worker-jwt';
import { env } from 'cloudflare:workers';

function withCors(response: Response): Response {
	const newHeaders = new Headers(response.headers);

	newHeaders.set('Access-Control-Allow-Origin', '*');
	newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	});
}

async function generateBQAccessToken(env: Env): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const claim = {
		iss: env.CLIENT_EMAIL,
		scope: 'https://www.googleapis.com/auth/bigquery',
		aud: 'https://oauth2.googleapis.com/token',
		iat: now,
		exp: now + 3600,
	};
	const key = env.PRIVATE_KEY.replace(/\\n/g, '\n');
	const jwt = await sign(claim, key, {
		algorithm: 'RS256',
	});
	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
	});
	const { access_token } = (await response.json()) as { access_token: string };
	return access_token;
}

async function getStatelessIds(request: Request) {
	const now = Math.floor(Date.now() / 1000);
	const visitorBucket = Math.floor(now / (60 * 60 * 24)); // 1-day window
	const sessionBucket = Math.floor(now / (60 * 30)); // 30-minute window

	const cfIp = request.headers.get('cf-connecting-ip') ?? 'UNKNOWN_IP';
	const userAgent = request.headers.get('User-Agent') ?? '';
	const acceptLang = request.headers.get('Accept-Language') ?? '';
	const acceptEnc = request.headers.get('Accept-Encoding') ?? '';

	const fingerprint = cfIp + userAgent + acceptLang + acceptEnc;

	const visitor_id = await hashSessionId(fingerprint + visitorBucket);
	const session_id = await hashSessionId(fingerprint + sessionBucket);

	return { visitor_id, session_id };
}

async function hashSessionId(fingerprint: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(fingerprint);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	return hashHex;
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function normalizeIpList(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
	}
	if (typeof value === 'string') {
		return value
			.split(/[,\s]+/)
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return [];
}

function isIpBlocked(settings: Record<string, unknown>, ip: string): boolean {
	if (!ip || ip === 'UNKNOWN_IP') return false;
	const blockedIps = normalizeIpList(settings.blocked_ips ?? settings.blockedIps);
	return blockedIps.includes(ip);
}

function isHostnameAllowed(settings: Record<string, unknown>, host: string): boolean {
	const allowed = normalizeIpList(settings.allowed_hostNames ?? settings.allowedHostNames);
	if (allowed.length === 0) return true; // no rules = allow all
	if (!host) return false;
	return allowed.some((pattern) => {
		if (pattern.startsWith('*.')) {
			const base = pattern.slice(2); // "uselinkkit.com"
			return host === base || host.endsWith('.' + base);
		}
		return host === pattern;
	});
}

async function addData(
	request: Request,
	env: Env,
	accessToken: string,
	datasetId: string,
	arr: { event_type: string; json: { [x: string]: any }; timestamp?: string }[]
): Promise<Response> {
	const tableId = 'events';
	const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${env.PROJECT_ID}/datasets/${datasetId}/tables/${tableId}/insertAll`;

	const rows = arr.map(({ event_type, json, timestamp }) => ({
		json: {
			event_type,
			data: JSON.stringify(json),
			timestamp: timestamp ?? new Date().toISOString(),
		},
	}));
	const payload = { rows };

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify(payload),
	});
	if (response.ok) return new Response('Success', { status: 200 });

	return new Response('Somethign went wrong', { status: response.status });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { url, method } = request;
		const { pathname, searchParams } = new URL(url);
		// Handle GET request to root path
		if (method === 'GET' && new URL(url).pathname === '/') {
			return Response.redirect('https://flooanalytics.com/', 301);
		}
		if (request.method === 'OPTIONS') {
			return withCors(new Response(null, { status: 204 }));
		}

		if (pathname.match(/^\/([^\/]+)\/import\/?$/)) {
			const match = pathname.match(/^\/([^\/]+)\/import\/?$/);

			if (!match) {
				return new Response('Invalid route', { status: 404 });
			}

			const site_id = match[1];
			const body = await request.json();
			const access_token = await generateBQAccessToken(env);
			//@ts-ignore
			const arr = body.map(({ event_type, timestamp, ...rest }) => ({
				event_type,
				timestamp,
				json: {
					...rest,
				},
			}));

			await addData(request, env, access_token, `site_${site_id}`, arr);
			return withCors(new Response(`Data imported for site_id : ${site_id}`, { status: 200 }));
		}

		if (pathname === '/add-plan') {
			await env.PLANS.put(
				'scale',
				JSON.stringify({
					max_page_views: 10000,
					max_sites: 25,
					max_team_members: 10,
				})
			);
			return new Response('added');
		}

		// ✅ New route for KV management
		if (pathname === '/block-settings') {
			const siteId = searchParams.get('siteId');
			if (!siteId) return new Response('Missing siteId', { status: 400 });

			const key = `site:settings:${siteId}`;

			if (request.method === 'GET') {
				const data = await env.SITE_SETTINGS.get(key);
				return new Response(data || '{}', {
					headers: { 'Content-Type': 'application/json' },
				});
			}

			if (request.method === 'POST') {
				const body = (await request.json()) as {};
				const existing = JSON.parse((await env.SITE_SETTINGS.get(key)) || '{}');
				const updated = { ...existing, ...body };
				await env.SITE_SETTINGS.put(key, JSON.stringify(updated));
				return new Response('Saved', { status: 200 });
			}

			return new Response('Method not allowed', { status: 405 });
		}

		// Check if it's a request for common browser assets
		const reqPath = new URL(url).pathname;
		if (reqPath.match(/\.(ico|png|jpg|jpeg)$/) || reqPath.includes('favicon') || reqPath.includes('apple-touch-icon')) {
			return new Response(null, { status: 404 });
		}

		const urlParams = new URLSearchParams(url.split('?')[1]);

		const events = urlParams.get('events') ? JSON.parse(decodeURIComponent(urlParams.get('events')!)) : '';

		let browser = 'Unknown Browser';
		const site_id = urlParams.get('sid')!;
		const country_code = request.cf?.country;
		const city = request.cf?.city;
		const region = request.cf?.region;

		if (pathname === '/get-exhausted-quota') {
			const user_id = urlParams.get('user_id')!;
			const plan_name = urlParams.get('plan_name')!;

			if (!user_id || !plan_name) {
				return new Response('missing user_id or plan_name', { status: 404 });
			}

			const id = env.USER_QUOTA.idFromName(user_id);
			const obj = env.USER_QUOTA.get(id);

			const quotaRes = await obj.fetch('https://quota/check', {
				method: 'POST',
				body: JSON.stringify({
					event_type: 'page_view',
					action: 'read',
					plan_name,
					user_id,
				}),
			});
			const resp = await quotaRes.json();

			return new Response(JSON.stringify(resp));
		}

		if (pathname === '/update-quota') {
			const user_id = urlParams.get('user_id')!;
			const plan_name = urlParams.get('plan_name')!;
			const event = urlParams.get('event')!;

			if (!user_id || !plan_name) {
				return new Response('missing user_id or plan_name', { status: 404 });
			}

			const id = env.USER_QUOTA.idFromName(user_id);
			const obj = env.USER_QUOTA.get(id);

			const quotaRes = await obj.fetch('https://quota/check', {
				method: 'POST',
				body: JSON.stringify({
					event_type: event,
					action: 'increment',
					plan_name,
					user_id,
				}),
			});
			const resp = await quotaRes.text();

			return new Response(JSON.stringify(resp), { status: quotaRes.status });
		}

		const currentDate = new Date().toISOString().split('T')[0];

		if (events === '' || events.length === 0) {
			// in case no events are received
			return new Response('ok', { status: 200 });
		}
		const userAgent = request.headers.get('User-Agent') ?? '';
		const cfIp = request.headers.get('cf-connecting-ip') ?? 'UNKNOWN_IP';
		const globalSettings = parseJsonObject(await env.SITE_SETTINGS.get('site:settings:global'));
		if (isIpBlocked(globalSettings, cfIp)) {
			return new Response('OK', { status: 200 });
		}

		const settingsKey = `site:settings:${site_id}`;
		const siteSettings = parseJsonObject(await env.SITE_SETTINGS.get(settingsKey));
		if (isIpBlocked(siteSettings, cfIp)) {
			return new Response('OK', { status: 200 });
		}
		const requestHost: string = events.length > 0 ? ((events[0][1] as any).host ?? '') : '';
		if (!isHostnameAllowed(siteSettings, requestHost)) {
			return new Response('OK', { status: 200 });
		}
		const acceptLang = request.headers.get('Accept-Language') ?? '';
		const acceptEnc = request.headers.get('Accept-Encoding') ?? '';
		const fingerprint = cfIp + userAgent + acceptLang + acceptEnc;

		let device_type = 'Unknown Device';

		if (/mobile/i.test(userAgent)) {
			device_type = 'Mobile';
		} else if (/tablet/i.test(userAgent)) {
			device_type = 'Tablet';
		} else if (/desktop/i.test(userAgent) || /windows|macintosh|linux/i.test(userAgent)) {
			device_type = 'Desktop';
		}

		if (/edg/i.test(userAgent)) {
			browser = 'Edge';
		} else if (/chrome|crios|crmo/i.test(userAgent)) {
			browser = 'Chrome';
		} else if (/firefox|fxios/i.test(userAgent)) {
			browser = 'Firefox';
		} else if (/safari/i.test(userAgent)) {
			browser = 'Safari';
		} else if (/msie|trident/i.test(userAgent)) {
			browser = 'Internet Explorer';
		} else if (/opr|opera/i.test(userAgent)) {
			browser = 'Opera';
		} else {
			browser = 'Unknown Browser';
		}

		const payloadArr = [];

		const { visitor_id, session_id } = await getStatelessIds(request);

		const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_user_plan_by_site`, {
			method: 'POST',
			headers: {
				apikey: env.SUPABASE_KEY,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ site_id_param: site_id }),
		});
		
		if (!res.ok) {
			console.error('RPC call failed:', await res.text());
			return new Response('error', { status: 400 });
		}

		const rpc_data = (await res.json()) as { plan_name: string; subscription_id: string; created_by: string };

		for (var i = 0; i < events.length; i++) {
			const [event, data] = events[i];
			// Ask the Durable Object to check quota
			const id = env.USER_QUOTA.idFromName(rpc_data.created_by);
			const obj = env.USER_QUOTA.get(id);

			const quotaRes = await obj.fetch('https://quota/check', {
				method: 'POST',
				body: JSON.stringify({
					event_type: event,
					user_id: rpc_data.created_by,
					plan_name: rpc_data.plan_name,
				}),
			});

			if (quotaRes.status === 429 || quotaRes.status === 400) {
				return quotaRes;
			}
			const { path } = data;
			if (path) {
			const upsertSite=	await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/upsert_site_path`, {
					method: 'POST',
					headers: {
						apikey: env.SUPABASE_KEY,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ _site_id: site_id, _path: path }),
				});
				  const upsertSiteData = await upsertSite.json();
   
			}
			const formattedData = { ...data, browser, user_agent: userAgent, country_code, city, region, device_type, session_id, visitor_id };
			const payload = {
				event_type: event,
				json: {
					...formattedData,
				},
			};
			payloadArr.push(payload);
		}
		const access_token = await generateBQAccessToken(env);
		await addData(request, env, access_token, `site_${site_id}`, payloadArr);
		return new Response('OK');
	},
} satisfies ExportedHandler<Env>;

export class PlanQuota implements DurableObject {
	private storage: DurableObjectStorage;
	private env: Env;

	constructor(private state: DurableObjectState, env: Env) {
		this.storage = state.storage;
		this.env = env;
	}
	async fetch(request: Request): Promise<Response> {
		const { event_type, action, plan_name, user_id } = await request.json<{
			event_type: string;
			action?: 'read' | 'increment';
			plan_name: string;
			user_id: string;
		}>();

		// Only enforce quota for page_view,team_member_added or site_created events
		if (event_type !== 'team_member_added' && event_type !== 'page_view' && event_type !== 'site_created') {
			return new Response('ok', { status: 200 });
		}
		const plan = await this.env.PLANS.get(plan_name);
		const plan_data = JSON.parse(plan!) as { max_page_views: number; max_sites: number; max_team_members: number };

		const now = new Date();
		const monthKey = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
		const monthlyKey = `quota:${user_id}:${monthKey}`;
		const teamMembersKey = `team_members:${user_id}`;
		const sitesKey = `sites:${user_id}`;

		// Read current stored values
		const totalTeamMembers = (await this.storage.get<number>(teamMembersKey)) || 0;
		const monthlyQuota = (await this.storage.get<Record<string, number>>(monthlyKey)) || { page_view: 0 };
		const totalSites = (await this.storage.get<number>(sitesKey)) || 0;
		if (action === 'read') {
			return new Response(
				JSON.stringify({
					consumed_page_view: monthlyQuota.page_view,
					team_members_added: totalTeamMembers,
					sites_owned: totalSites,
					allowed_page_view: plan_data.max_page_views,
					allowed_team_members: plan_data.max_team_members,
					allowed_sites: plan_data.max_sites,
				}),
				{ status: 200 }
			);
		}

		// Handle incrementing each event type
		switch (event_type) {
			case 'page_view':
				if (monthlyQuota.page_view >= plan_data.max_page_views) return new Response('Monthly page view limit reached', { status: 429 });
				monthlyQuota.page_view++;
				await this.storage.put(monthlyKey, monthlyQuota);
				break;

			case 'team_member_added':
				if (totalTeamMembers >= plan_data.max_team_members) return new Response('Team member limit reached', { status: 429 });
				await this.storage.put(teamMembersKey, totalTeamMembers + 1);
				break;

			case 'site_created':
				if (totalSites >= plan_data.max_sites) return new Response('Site limit reached', { status: 429 });
				await this.storage.put(sitesKey, totalSites + 1);
				break;

			default:
				return new Response('Unknown event type', { status: 400 });
		}

		return new Response('ok', { status: 200 });
	}
	alarm?(alarmInfo?: AlarmInvocationInfo): void | Promise<void> {
		throw new Error('Method not implemented.');
	}
	webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void> {
		throw new Error('Method not implemented.');
	}
	webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
		throw new Error('Method not implemented.');
	}
	webSocketError?(ws: WebSocket, error: unknown): void | Promise<void> {
		throw new Error('Method not implemented.');
	}
}
