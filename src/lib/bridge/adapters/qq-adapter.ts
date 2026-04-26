/**
 * QQ Bot Adapter — implements BaseChannelAdapter for QQ Bot API.
 *
 * C2C (private chat) only. Supports text + image inbound messages
 * and text-only passive reply outbound.
 *
 * Uses WebSocket gateway for real-time events and REST API for sending.
 * QQ Bot API requires passive replies (must reference an inbound message ID).
 */

import crypto from 'crypto';
import WebSocket from 'ws';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../types.js';
import type { FileAttachment } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import {
  getAccessToken,
  getGatewayUrl,
  clearTokenCache,
  sendPrivateMessage,
  sendMediaMessage,
  nextMsgSeq,
  buildIdentify,
  buildHeartbeat,
  buildResume,
  OP,
  INTENTS,
  type GatewayPayload,
} from './qq-api.js';
import {
  splitByStickers,
  hasStickerMarker,
  type StickerSegment,
} from './feishu-stickers.js';
import { QQStickerManager } from './qq-stickers.js';

export class QQAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'qq';

  private _running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private shouldReconnect = false;
  private stickerManager: QQStickerManager | null = null;

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[qq-adapter] Cannot start:', configError);
      return;
    }

    const store = getBridgeContext().store;
    const appId = store.getSetting('bridge_qq_app_id') || '';
    const appSecret = store.getSetting('bridge_qq_app_secret') || '';

    clearTokenCache();

    const token = await getAccessToken(appId, appSecret);
    const gatewayUrl = await getGatewayUrl(token);

    this._running = true;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;

    // Lazy-init sticker manager (loads manifest + cache from disk).
    this.stickerManager = new QQStickerManager();
    this.stickerManager.load();

    await this.connectGateway(gatewayUrl, token);

    console.log('[qq-adapter] Started');
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this.shouldReconnect = false;

    this.stopHeartbeat();

    if (this.ws) {
      try {
        this.ws.close(1000, 'adapter stopping');
      } catch { /* ignore */ }
      this.ws = null;
    }

    // Wake all waiters with null
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    this.queue = [];
    this.seenMessageIds.clear();

    console.log('[qq-adapter] Stopped');
  }

  isRunning(): boolean {
    return this._running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this._running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!message.replyToMessageId) {
      return { ok: false, error: 'Missing replyToMessageId for QQ passive reply' };
    }

    try {
      const store = getBridgeContext().store;
      const appId = store.getSetting('bridge_qq_app_id') || '';
      const appSecret = store.getSetting('bridge_qq_app_secret') || '';
      const token = await getAccessToken(appId, appSecret);

      let content = message.text;
      if (message.parseMode === 'HTML') {
        content = content.replace(/<[^>]+>/g, '');
      }

      // Fast path: no stickers → single text send.
      if (!this.stickerManager || !hasStickerMarker(content)) {
        return await sendPrivateMessage(token, {
          openid: message.address.chatId,
          content,
          msgId: message.replyToMessageId,
          msgSeq: nextMsgSeq(message.replyToMessageId),
        });
      }

      // Sticker path: split into segments, send each with its own msg_seq.
      // QQ requires unique msg_seq per reply to the same inbound msg_id.
      // We return success if at least one segment lands; partial failures
      // are logged but don't block the rest.
      const segments = splitByStickers(content);
      return await this.sendSegmented(
        token,
        message.address.chatId,
        message.replyToMessageId,
        segments,
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send a sequence of (text | sticker) segments as separate QQ messages.
   * Each piece consumes the next msg_seq for the inbound msg_id. The first
   * successful send's messageId is returned; the rest are sent best-effort.
   */
  private async sendSegmented(
    token: string,
    openid: string,
    msgId: string,
    segments: StickerSegment[],
  ): Promise<SendResult> {
    let firstResult: SendResult | null = null;
    let anySuccess = false;
    let lastError: string | undefined;

    for (const seg of segments) {
      const msgSeq = nextMsgSeq(msgId);

      let result: SendResult;
      if (seg.type === 'text') {
        result = await sendPrivateMessage(token, {
          openid,
          content: seg.value,
          msgId,
          msgSeq,
        });
      } else {
        // Sticker segment.
        result = await this.sendOneSticker(token, openid, msgId, msgSeq, seg.id);
      }

      if (result.ok) {
        anySuccess = true;
        if (!firstResult) firstResult = result;
      } else {
        lastError = result.error;
        console.warn(`[qq-adapter] Segment send failed (${seg.type}): ${result.error}`);
      }
    }

    if (anySuccess && firstResult) return firstResult;
    return { ok: false, error: lastError ?? 'all segments failed' };
  }

  /**
   * Send one sticker. Falls back to a text description if the file_info
   * lookup or media send fails — better than a silent drop.
   */
  private async sendOneSticker(
    token: string,
    openid: string,
    msgId: string,
    msgSeq: number,
    stickerId: string,
  ): Promise<SendResult> {
    const mgr = this.stickerManager;
    if (!mgr) {
      return { ok: false, error: 'sticker manager not initialized' };
    }

    const fileInfo = await mgr.getFileInfo(token, openid, stickerId);
    if (fileInfo) {
      const mediaResult = await sendMediaMessage(token, {
        openid,
        msgId,
        msgSeq,
        fileInfo,
      });
      if (mediaResult.ok) return mediaResult;
      console.warn(`[qq-adapter] Media send failed for ${stickerId}: ${mediaResult.error}`);
    }

    // Fallback: text describing the sticker so the user gets *something*.
    const entry = mgr.getEntry(stickerId);
    const fallback = entry
      ? `[贴图:${entry.emotion}${entry.desc ? `/${entry.desc}` : ''}]`
      : `[贴图:${stickerId}]`;
    return await sendPrivateMessage(token, {
      openid,
      content: fallback,
      msgId,
      msgSeq,
    });
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const store = getBridgeContext().store;
    const appId = store.getSetting('bridge_qq_app_id');
    if (!appId) return 'bridge_qq_app_id not configured';

    const appSecret = store.getSetting('bridge_qq_app_secret');
    if (!appSecret) return 'bridge_qq_app_secret not configured';

    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_qq_allowed_users') || '';
    if (!allowedUsers) return true;

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId);
  }

  // ── Gateway WebSocket ───────────────────────────────────────

  private connectGateway(gatewayUrl: string, token: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(gatewayUrl);
      this.ws = ws;

      let resolved = false;

      ws.on('message', (data) => {
        try {
          const payload = JSON.parse(data.toString()) as GatewayPayload;
          this.handleGatewayPayload(payload, token, ws);

          // Resolve on READY dispatch
          if (
            payload.op === OP.DISPATCH &&
            payload.t === 'READY' &&
            !resolved
          ) {
            resolved = true;
            resolve();
          }
        } catch (err) {
          console.error('[qq-adapter] Failed to parse gateway payload:', err instanceof Error ? err.message : err);
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`[qq-adapter] WebSocket closed: code=${code}, reason=${reason.toString()}`);
        this.stopHeartbeat();

        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket closed before READY: code=${code}`));
          return;
        }

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        console.error('[qq-adapter] WebSocket error:', err instanceof Error ? err.message : err);
      });
    });
  }

  private handleGatewayPayload(payload: GatewayPayload, token: string, ws: WebSocket): void {
    switch (payload.op) {
      case OP.HELLO: {
        const interval = (payload.d as { heartbeat_interval: number })?.heartbeat_interval || 45000;
        this.startHeartbeat(ws, interval);

        // Send Identify or Resume
        if (this.sessionId && this.lastSequence !== null) {
          ws.send(JSON.stringify(buildResume(token, this.sessionId, this.lastSequence)));
        } else {
          ws.send(JSON.stringify(buildIdentify(token, INTENTS.PUBLIC_MESSAGES)));
        }
        break;
      }

      case OP.DISPATCH: {
        if (payload.s !== undefined) {
          this.lastSequence = payload.s;
        }

        if (payload.t === 'READY') {
          const readyData = payload.d as { session_id?: string };
          if (readyData?.session_id) {
            this.sessionId = readyData.session_id;
          }
          this.reconnectAttempts = 0;
          console.log('[qq-adapter] Gateway READY, sessionId:', this.sessionId);
        } else if (payload.t === 'RESUMED') {
          this.reconnectAttempts = 0;
          console.log('[qq-adapter] Gateway RESUMED');
        } else if (payload.t === 'C2C_MESSAGE_CREATE') {
          this.handleC2CMessage(payload.d as QQC2CMessageData);
        }
        break;
      }

      case OP.HEARTBEAT_ACK:
        // No-op
        break;

      case OP.RECONNECT:
        console.log('[qq-adapter] Server requested reconnect');
        ws.close(4000, 'server reconnect');
        break;

      case OP.INVALID_SESSION:
        console.warn('[qq-adapter] Invalid session, will re-identify');
        this.sessionId = null;
        this.lastSequence = null;
        ws.close(4000, 'invalid session');
        break;
    }
  }

  // ── C2C Message Handling ────────────────────────────────────

  private handleC2CMessage(data: QQC2CMessageData): void {
    if (!data?.id || !data?.author?.user_openid) return;

    // Dedup
    if (this.seenMessageIds.has(data.id)) return;
    this.seenMessageIds.set(data.id, true);

    // Evict oldest when exceeding limit
    if (this.seenMessageIds.size > 1000) {
      const excess = this.seenMessageIds.size - 1000;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }

    const userId = data.author.user_openid;

    // Authorization check
    if (!this.isAuthorized(userId, userId)) {
      console.warn('[qq-adapter] Unauthorized message from:', userId);
      return;
    }

    const text = (data.content || '').trim();
    const address = {
      channelType: 'qq' as const,
      chatId: userId,
      userId,
      displayName: userId.slice(0, 8),
    };

    // Filter image attachments
    const imageEnabled = getBridgeContext().store.getSetting('bridge_qq_image_enabled') !== 'false';
    const imageAttachments = imageEnabled
      ? (data.attachments || []).filter((a) => a.content_type?.startsWith('image/'))
      : [];

    if (imageAttachments.length > 0) {
      // Download images async, then enqueue
      this.downloadImages(imageAttachments).then((result) => {
        const { files, failedCount } = result;
        const ts = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();

        if (files.length > 0) {
          // At least some images succeeded — enqueue with attachments
          const errorNote = failedCount > 0 ? `\n[${failedCount} image(s) failed to download]` : '';
          const inbound: InboundMessage = {
            messageId: data.id,
            address,
            text: text + errorNote,
            timestamp: ts,
            attachments: files,
          };
          this.enqueue(inbound);
        } else if (text) {
          // All images failed but there is text — enqueue text only with a note
          const inbound: InboundMessage = {
            messageId: data.id,
            address,
            text: text + `\n[${failedCount} image(s) failed to download]`,
            timestamp: ts,
          };
          this.enqueue(inbound);
        } else {
          // Image-only message and all downloads failed — enqueue an error
          // so bridge-manager can reply to the user instead of silently dropping
          const inbound: InboundMessage = {
            messageId: data.id,
            address,
            text: '',
            timestamp: ts,
            // Store failure info so handleMessage can surface it
            raw: { imageDownloadFailed: true, failedCount },
          };
          this.enqueue(inbound);
        }

        // Audit log
        try {
          const summary = files.length > 0
            ? `[${files.length} image(s)] ${text.slice(0, 150)}`
            : `[${failedCount} image(s) failed] ${text.slice(0, 150)}`;
          getBridgeContext().store.insertAuditLog({
            channelType: 'qq',
            chatId: userId,
            direction: 'inbound',
            messageId: data.id,
            summary,
          });
        } catch { /* best effort */ }
      });
    } else {
      if (!text) return;

      const inbound: InboundMessage = {
        messageId: data.id,
        address,
        text,
        timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
      };
      this.enqueue(inbound);

      // Audit log
      try {
        getBridgeContext().store.insertAuditLog({
          channelType: 'qq',
          chatId: userId,
          direction: 'inbound',
          messageId: data.id,
          summary: text.slice(0, 200),
        });
      } catch { /* best effort */ }
    }
  }

  // ── Image Download ──────────────────────────────────────────

  private async downloadImages(
    attachments: QQAttachment[],
  ): Promise<{ files: FileAttachment[]; failedCount: number }> {
    const maxSizeMB = parseInt(
      getBridgeContext().store.getSetting('bridge_qq_max_image_size') || '20',
      10,
    ) || 20;
    const maxSizeBytes = maxSizeMB * 1024 * 1024;

    const files: FileAttachment[] = [];
    let failedCount = 0;

    for (const att of attachments) {
      try {
        let url = att.url;
        // Fix protocol-relative URLs
        if (url.startsWith('//')) {
          url = 'https:' + url;
        }

        // Check declared size before downloading
        if (att.size && att.size > maxSizeBytes) {
          console.warn(`[qq-adapter] Image too large (${att.size} bytes), skipping: ${att.filename || 'unnamed'}`);
          failedCount++;
          continue;
        }

        const res = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          console.warn(`[qq-adapter] Image download failed (${res.status}): ${url}`);
          failedCount++;
          continue;
        }

        const buffer = Buffer.from(await res.arrayBuffer());

        if (buffer.length > maxSizeBytes) {
          console.warn(`[qq-adapter] Downloaded image too large (${buffer.length} bytes), skipping`);
          failedCount++;
          continue;
        }

        if (buffer.length === 0) {
          console.warn('[qq-adapter] Downloaded image is empty, skipping');
          failedCount++;
          continue;
        }

        const name = att.filename || `image_${crypto.randomUUID().slice(0, 8)}.png`;
        files.push({
          id: crypto.randomUUID(),
          name,
          type: att.content_type || 'image/png',
          size: buffer.length,
          data: buffer.toString('base64'),
        });
      } catch (err) {
        console.warn('[qq-adapter] Image download error:', err instanceof Error ? err.message : err);
        failedCount++;
      }
    }

    return { files, failedCount };
  }

  // ── Heartbeat ───────────────────────────────────────────────

  private startHeartbeat(ws: WebSocket, intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(buildHeartbeat(this.lastSequence)));
      }
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Reconnection ────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error('[qq-adapter] Max reconnect attempts reached, giving up');
      this._running = false;
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
    console.log(`[qq-adapter] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(async () => {
      if (!this.shouldReconnect) return;

      try {
        const store = getBridgeContext().store;
        const appId = store.getSetting('bridge_qq_app_id') || '';
        const appSecret = store.getSetting('bridge_qq_app_secret') || '';
        const token = await getAccessToken(appId, appSecret);
        const gatewayUrl = await getGatewayUrl(token);
        await this.connectGateway(gatewayUrl, token);
        console.log('[qq-adapter] Reconnected successfully');
      } catch (err) {
        console.error('[qq-adapter] Reconnect failed:', err instanceof Error ? err.message : err);
        this.scheduleReconnect();
      }
    }, delay);
  }
}

// ── Types ──────────────────────────────────────────────────────

interface QQC2CMessageData {
  id: string;
  author: { user_openid: string };
  content: string;
  timestamp: string;
  attachments?: QQAttachment[];
}

interface QQAttachment {
  content_type: string;
  filename?: string;
  url: string;
  size?: number;
}

// Self-register so bridge-manager can create QQAdapter via the registry.
registerAdapterFactory('qq', () => new QQAdapter());
