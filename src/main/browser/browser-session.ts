import { BrowserWindow } from 'electron';

function allowed(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('浏览器只允许打开 HTTP 或 HTTPS 页面');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || /^127\./.test(host) || /^10\./.test(host)
    || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host.endsWith('.local')) throw new Error('禁止打开本机、局域网或云元数据地址');
  return url;
}

export class BrowserSession {
  private window: BrowserWindow | undefined;

  private ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.window = new BrowserWindow({ title: 'Agent 浏览器', width: 1100, height: 760, show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, target) => {
      try { allowed(target); } catch { event.preventDefault(); }
    });
    this.window.webContents.on('will-redirect', (event, target) => { try { allowed(target); } catch { event.preventDefault(); } });
    this.window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.window.on('closed', () => { this.window = undefined; });
    return this.window;
  }

  async open(raw: string, signal: AbortSignal): Promise<{ url: string; title: string }> {
    const url = allowed(raw);
    signal.throwIfAborted();
    const window = this.ensure();
    await window.loadURL(url.toString());
    signal.throwIfAborted();
    const finalUrl = window.webContents.getURL();
    allowed(finalUrl);
    return { url: finalUrl, title: await window.webContents.executeJavaScript('document.title', true) as string };
  }

  async read(signal: AbortSignal): Promise<{ url: string; title: string; text: string }> {
    const window = this.ensure();
    signal.throwIfAborted();
    allowed(window.webContents.getURL());
    const value = await window.webContents.executeJavaScript(`({ url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 30000) })`, true) as { url: string; title: string; text: string };
    signal.throwIfAborted();
    allowed(value.url);
    return value;
  }

  async screenshot(signal: AbortSignal): Promise<{ url: string; data: string }> {
    const window = this.ensure();
    signal.throwIfAborted();
    allowed(window.webContents.getURL());
    const image = await window.webContents.capturePage();
    signal.throwIfAborted();
    const url = window.webContents.getURL();
    allowed(url);
    return { url, data: image.toPNG().toString('base64') };
  }

  async click(selector: string, signal: AbortSignal): Promise<{ url: string; text: string }> {
    const window = this.ensure();
    if (selector.length > 300) throw new Error('点击选择器过长');
    signal.throwIfAborted();
    const argument = JSON.stringify(selector);
    const value = await window.webContents.executeJavaScript(`(() => { const el = document.querySelector(${argument}); if (!el) throw new Error('未找到目标元素'); el.click(); return { url: location.href, text: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 500) }; })()`, true) as { url: string; text: string };
    signal.throwIfAborted();
    allowed(value.url);
    return value;
  }

  async type(selector: string, text: string, signal: AbortSignal): Promise<{ url: string; text: string }> {
    const window = this.ensure();
    if (selector.length > 300 || text.length > 2_000) throw new Error('输入参数过长');
    signal.throwIfAborted();
    const selectorLiteral = JSON.stringify(selector);
    const textLiteral = JSON.stringify(text);
    const value = await window.webContents.executeJavaScript(`(() => { const el = document.querySelector(${selectorLiteral}); if (!el) throw new Error('未找到输入元素'); el.focus(); if (el instanceof HTMLInputElement) { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(el, ${textLiteral}); } else if (el instanceof HTMLTextAreaElement) { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set; setter?.call(el, ${textLiteral}); } else if (el instanceof HTMLElement && el.isContentEditable) { el.textContent = ${textLiteral}; } else { throw new Error('目标元素不是可输入控件'); } el.dispatchEvent(new Event('input', { bubbles: true })); return { url: location.href, text: (el.getAttribute('aria-label') || el.getAttribute('name') || '').slice(0, 500) }; })()`, true) as { url: string; text: string };
    signal.throwIfAborted();
    allowed(value.url);
    return value;
  }

  close(): void { if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = undefined; }
}
