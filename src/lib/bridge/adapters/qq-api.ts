/**
 * QQ Bot HTTP / WebSocket protocol helpers.
 *
 * Pure protocol layer — no business logic, no adapter state.
 * Covers token management, gateway discovery, WS frame builders,
 * and message sending via the QQ Bot open-platform API.
 */

import type { SendResult } from '../types.js';

// ── QQ Open-Platform endpoints ───────────────────────────────────

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

// ── Token Management ─────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch-ms
}

let _cachedToken: CachedToken | null = null;

/**
 * Obtain (or return cached) access token for the QQ Bot API.
 * Automatically refreshes 60 s before expiry.
 */
export async function getAccessToken(
  appId: string,
  clientSecret: string,
): Promise<string> {
  const now = Date.now();
  if (_cachedToken && now < _cachedToken.expiresAt) {
    return _cachedToken.accessToken;
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getAccessToken failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number; // seconds
  };

  _cachedToken = {
    accessToken: data.access_token,
    // Refresh 60 s before actual expiry
    expiresAt: now + (data.expires_in - 60) * 1000,
  };

  return _cachedToken.accessToken;
}

/** Clear the cached token (useful on auth errors). */
export function clearTokenCache(): void {
  _cachedToken = null;
}

// ── Gateway ──────────────────────────────────────────────────────

/** Fetch the WebSocket gateway URL for QQ Bot events. */
export async function getGatewayUrl(accessToken: string): Promise<string> {
  const res = await fetch(`${API_BASE}/gateway`, {
    headers: { Authorization: `QQBot ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getGatewayUrl failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { url: string };
  return data.url;
}

// ── WebSocket OP codes ───────────────────────────────────────────

export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// ── Gateway payload type ─────────────────────────────────────────

export interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

// ── Frame builders ───────────────────────────────────────────────

export function buildIdentify(
  token: string,
  intents: number,
): GatewayPayload {
  return {
    op: OP.IDENTIFY,
    d: {
      token: `QQBot ${token}`,
      intents,
      shard: [0, 1],
    },
  };
}

export function buildHeartbeat(
  lastSequence: number | null,
): GatewayPayload {
  return { op: OP.HEARTBEAT, d: lastSequence };
}

export function buildResume(
  token: string,
  sessionId: string,
  seq: number,
): GatewayPayload {
  return {
    op: OP.RESUME,
    d: {
      token: `QQBot ${token}`,
      session_id: sessionId,
      seq,
    },
  };
}

// ── Intent constants ─────────────────────────────────────────────

export const INTENTS = {
  PUBLIC_MESSAGES: 1 << 25,
} as const;

// ── Message Sending ──────────────────────────────────────────────

export interface QQSendMessageParams {
  openid: string;
  content: string;
  msgId: string;
  msgSeq: number;
}

/**
 * Auto-incrementing msg_seq counter keyed by inbound message ID.
 * QQ requires a unique msg_seq for each reply to the same inbound message.
 */
const _seqMap = new Map<string, number>();

/** Max entries to keep in the seq map to prevent unbounded growth. */
const SEQ_MAP_MAX = 500;

export function nextMsgSeq(inboundMsgId: string): number {
  const current = _seqMap.get(inboundMsgId) ?? 0;
  const next = current + 1;
  _seqMap.set(inboundMsgId, next);

  // Evict oldest entries when the map grows too large
  if (_seqMap.size > SEQ_MAP_MAX) {
    const keysToDelete = Array.from(_seqMap.keys()).slice(
      0,
      _seqMap.size - SEQ_MAP_MAX,
    );
    for (const key of keysToDelete) {
      _seqMap.delete(key);
    }
  }

  return next;
}

// ── Rich Media (image / file_data base64 upload + msg_type=7 send) ──
//
// QQ C2C rich media flow:
//   1) POST /v2/users/{openid}/files with file_data base64 (or url) → returns file_info
//   2) POST /v2/users/{openid}/messages with msg_type=7 + media.file_info
//
// file_info is openid-scoped and has a TTL (seconds, returned in the upload response,
// typically ~10 min). Caller is responsible for caching/expiry.

export type QQFileType = 1 | 2 | 3 | 4; // 1=image, 2=video, 3=voice, 4=file

export interface QQUploadFileResult {
  fileInfo: string;
  fileUuid?: string;
  ttl: number;
}

/**
 * Upload a media file via base64 and return file_info for use in subsequent
 * sendMediaMessage call. srv_send_msg is forced to false — we do upload-only
 * and keep send as a separate explicit step.
 */
export async function uploadFileBase64(
  accessToken: string,
  openid: string,
  fileType: QQFileType,
  fileDataBase64: string,
): Promise<QQUploadFileResult> {
  const res = await fetch(
    `${API_BASE}/v2/users/${encodeURIComponent(openid)}/files`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${accessToken}`,
      },
      body: JSON.stringify({
        file_type: fileType,
        file_data: fileDataBase64,
        srv_send_msg: false,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`uploadFileBase64 failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    file_uuid?: string;
    file_info?: string;
    ttl?: number;
  };

  if (!data.file_info) {
    throw new Error(`uploadFileBase64: response missing file_info: ${JSON.stringify(data)}`);
  }

  return {
    fileInfo: data.file_info,
    fileUuid: data.file_uuid,
    ttl: data.ttl ?? 600,
  };
}

export interface QQSendMediaParams {
  openid: string;
  msgId: string;
  msgSeq: number;
  fileInfo: string;
  content?: string;
}

/** Send a rich-media (image) message. msg_type=7. */
export async function sendMediaMessage(
  accessToken: string,
  params: QQSendMediaParams,
): Promise<SendResult> {
  const { openid, msgId, msgSeq, fileInfo, content } = params;

  try {
    const res = await fetch(
      `${API_BASE}/v2/users/${encodeURIComponent(openid)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `QQBot ${accessToken}`,
        },
        body: JSON.stringify({
          // Empty content avoids a trailing blank text line under the image
          // in QQ's C2C rendering. Pass an explicit caption only when needed.
          content: content ?? '',
          msg_type: 7,
          msg_id: msgId,
          msg_seq: msgSeq,
          media: { file_info: fileInfo },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `QQ media API ${res.status}: ${text}` };
    }

    const data = (await res.json()) as { id?: string };
    return { ok: true, messageId: data.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

/** Send a private (C2C) message to a QQ user. */
export async function sendPrivateMessage(
  accessToken: string,
  params: QQSendMessageParams,
): Promise<SendResult> {
  const { openid, content, msgId, msgSeq } = params;

  try {
    const res = await fetch(
      `${API_BASE}/v2/users/${encodeURIComponent(openid)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `QQBot ${accessToken}`,
        },
        body: JSON.stringify({
          content,
          msg_type: 0,
          msg_id: msgId,
          msg_seq: msgSeq,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `QQ API ${res.status}: ${text}` };
    }

    const data = (await res.json()) as { id?: string };
    return { ok: true, messageId: data.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}
