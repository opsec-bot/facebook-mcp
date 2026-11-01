// Talks to the real server over stdio with the MCP client, like Claude Code does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('server exposes all tools and handles calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbmcp-srv-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['src/server.js'], env: { ...process.env, FB_MCP_DATA_DIR: dir } });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  try {
    assert.match(client.getInstructions() ?? '', /signed in as the user/);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'browser_back', 'browser_click', 'browser_hover', 'browser_navigate', 'browser_press_key', 'browser_screenshot',
      'browser_scroll', 'browser_select_option', 'browser_snapshot', 'browser_type', 'browser_upload_files', 'browser_wait',
      'marketplace_create_listing', 'marketplace_get_listing', 'marketplace_list_conversations', 'marketplace_login',
      'marketplace_message_seller', 'marketplace_publish_listing', 'marketplace_read_conversation', 'marketplace_reply',
      'marketplace_save_listing', 'marketplace_saved_listings', 'marketplace_search', 'marketplace_seller_profile',
      'marketplace_set_location', 'marketplace_status', 'marketplace_update_listing', 'marketplace_your_listings',
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.marketplace_search.annotations.readOnlyHint, true);
    assert.equal(byName.marketplace_update_listing.annotations.destructiveHint, true);

    const status = await client.callTool({ name: 'marketplace_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).loggedIn, false);

    const bad = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } });
    assert.equal(bad.isError, true);
    const badArg = await client.callTool({ name: 'marketplace_get_listing', arguments: { listing: 'not-a-listing' } });
    assert.match(badArg.content[0].text, /Not a Marketplace listing/);
  } finally {
    await client.close();
  }
});
