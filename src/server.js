#!/usr/bin/env node
// MCP server exposing read-only Facebook Marketplace browsing tools over stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { closeContext, interactiveLogin } from './browser.js';
import {
  searchListings,
  getListing,
  getPageText,
  loginStatus,
  SORT_OPTIONS,
  CONDITIONS,
} from './marketplace.js';

const server = new McpServer({ name: 'facebook-marketplace', version: '0.1.0' });

const json = (obj) => ({ type: 'text', text: JSON.stringify(obj, null, 2) });
const image = (buf) => ({ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' });

function wrap(fn) {
  return async (args) => {
    try {
      return { content: await fn(args) };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  };
}

server.registerTool(
  'marketplace_search',
  {
    title: 'Search Facebook Marketplace',
    description:
      'Search Facebook Marketplace listings and return title, price, location and link for each. ' +
      'Uses the signed-in Facebook account. If location is omitted, the account\'s saved Marketplace location is used.',
    inputSchema: {
      query: z.string().optional().describe('Search terms, e.g. "standing desk". Optional when browsing a category.'),
      location: z
        .string()
        .optional()
        .describe(
          'Marketplace location slug or numeric location id as it appears in Marketplace URLs, ' +
            'e.g. "nyc", "la", "sanfrancisco", "chicago", "austin", or "108424279189115".'
        ),
      category: z
        .string()
        .optional()
        .describe('Category slug from Marketplace URLs, e.g. "vehicles", "propertyrentals", "electronics", "furniture", "free".'),
      min_price: z.number().int().nonnegative().optional(),
      max_price: z.number().int().nonnegative().optional(),
      sort: z.enum(Object.keys(SORT_OPTIONS)).optional(),
      days_since_listed: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional(),
      conditions: z.array(z.enum(CONDITIONS)).optional(),
      delivery: z.enum(['pickup', 'shipping']).optional(),
      radius_km: z.number().int().positive().optional().describe('Search radius in kilometres.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max listings to return (default 24).'),
    },
  },
  wrap(async (a) => {
    if (!a.query && !a.category) throw new Error('Provide a query, a category, or both.');
    const res = await searchListings({
      query: a.query,
      location: a.location,
      category: a.category,
      minPrice: a.min_price,
      maxPrice: a.max_price,
      sort: a.sort,
      daysSinceListed: a.days_since_listed,
      conditions: a.conditions,
      delivery: a.delivery,
      radiusKm: a.radius_km,
      limit: a.limit,
    });
    return [json(res)];
  })
);

server.registerTool(
  'marketplace_get_listing',
  {
    title: 'Get Marketplace listing details',
    description:
      'Open a single Marketplace listing and return its title, price, condition, description, seller, photo URLs ' +
      'and the raw page text. Set screenshot=true to also see the listing page as an image.',
    inputSchema: {
      listing: z.string().describe('Listing URL (facebook.com/marketplace/item/...) or numeric listing id.'),
      screenshot: z.boolean().optional(),
    },
  },
  wrap(async ({ listing, screenshot }) => {
    const res = await getListing(listing, { screenshot });
    return [json(res.listing), ...(res.screenshot ? [image(res.screenshot)] : [])];
  })
);

server.registerTool(
  'marketplace_page_text',
  {
    title: 'Read a Marketplace page',
    description:
      'Fallback: load any facebook.com/marketplace URL and return its visible text (and optionally a screenshot). ' +
      'Use when the structured tools miss something or Facebook changed its layout.',
    inputSchema: {
      url: z.string().describe('A facebook.com/marketplace URL.'),
      screenshot: z.boolean().optional(),
    },
  },
  wrap(async ({ url, screenshot }) => {
    const res = await getPageText(url, { screenshot });
    return [json({ url: res.url, text: res.text }), ...(res.screenshot ? [image(res.screenshot)] : [])];
  })
);

server.registerTool(
  'marketplace_status',
  {
    title: 'Check Facebook login',
    description: 'Report whether the browser profile has a signed-in Facebook session.',
    inputSchema: {},
  },
  wrap(async () => [json(await loginStatus())])
);

server.registerTool(
  'marketplace_login',
  {
    title: 'Sign in to Facebook',
    description:
      'Open a visible browser window on the user\'s computer so they can sign in to Facebook themselves. ' +
      'Waits up to 5 minutes. Only call this when the user asks or a tool reports that login is needed.',
    inputSchema: {},
  },
  wrap(async () => [json(await interactiveLogin())])
);

const shutdown = async () => {
  await closeContext();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
