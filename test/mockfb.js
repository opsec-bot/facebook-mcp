// A small fake facebook.com for tests. Pages mimic the structures the real site uses
// (embedded Relay JSON, GraphQL pagination, aria-labels on chat UI) as documented by
// public Marketplace automation projects. It cannot prove the real site still matches.
import http from 'node:http';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

export async function startImageServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

const listing = (id, title, price, city, extra = {}) => ({
  __typename: 'GroupCommerceProductItem',
  id,
  marketplace_listing_title: title,
  listing_price: { formatted_amount: price, amount: price.replace(/[^\d.]/g, '') || '0', currency: 'USD' },
  location: { reverse_geocode: { city, state: 'NY', city_page: { display_name: `${city}, NY` } } },
  primary_listing_photo: { image: { uri: `https://scontent.example/${id}.jpg` } },
  marketplace_listing_seller: { __typename: 'User', id: `9${id}`, name: `Seller ${id}` },
  is_sold: false,
  is_pending: false,
  ...extra,
});

// Facebook nests Relay payloads deep inside ScheduledServerJS "require" arrays.
const relayScript = (data) =>
  `<script type="application/json" data-sjs>${JSON.stringify({
    require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_x', { __bbox: { complete: true, result: { data } } }]]] } }]]],
  })}</script>`;

const card = (id, lines) =>
  `<a href="/marketplace/item/${id}/?ref=search&amp;referral_code=null"><img src="https://scontent.example/${id}.jpg" alt="${lines[lines.length - 2]}"><div>${lines.map((l) => `<span>${l}</span>`).join('<br>')}</div></a>`;

function searchPage() {
  const first = [
    listing('111', 'Trek FX 2', '$150', 'Brooklyn', { strikethrough_price: { formatted_amount: '$200' }, creation_time: 1761955200 }),
    listing('222', 'Kids bike', 'Free', 'Queens'),
  ];
  return `<!doctype html><html><body><div role="main"><div id="grid">
    ${card('111', ['Just listed', '$150', '$200', 'Trek FX 2', 'Brooklyn, NY'])}
    ${card('222', ['Free', 'Kids bike', 'Queens, NY'])}
  </div></div>
  ${relayScript({ marketplace_search: { feed_units: { edges: first.map((l) => ({ node: { __typename: 'MarketplaceFeedListingStoryObject', listing: l } })), page_info: { has_next_page: true, end_cursor: 'c1' } } } })}
  <script>
    let loaded = false;
    window.addEventListener('scroll', async () => {
      if (loaded) return; loaded = true;
      const r = await fetch('/api/graphql/', { method: 'POST', body: 'doc_id=1' });
      await r.text();
      const a = document.createElement('a');
      a.href = '/marketplace/item/333/';
      a.innerHTML = '<div><span>$90</span><br><span>BMX</span><br><span>Bronx, NY</span></div>';
      document.getElementById('grid').appendChild(a);
    });
    document.body.style.height = '6000px';
  </script></body></html>`;
}

function graphqlPage2() {
  const edges = [
    { node: { listing: listing('333', 'BMX', '$90', 'Bronx', { is_pending: true }) } },
    { node: { listing: listing('444', 'Old cruiser', '$40', 'Harlem', { is_sold: true }) } },
  ];
  return 'for (;;);' + JSON.stringify({ data: { marketplace_search: { feed_units: { edges, page_info: { has_next_page: false } } } } }) + '\n' + JSON.stringify({ label: 'deferred', data: {} });
}

function itemPage(imageBase, state) {
  const head = listing('111', 'Trek FX 2 Hybrid Bike', '$350', 'Brooklyn', { creation_time: 1761955200 });
  // Detail fields arrive in a second object with the same id, as on the real site.
  const detail = {
    id: '111',
    redacted_description: { text: 'Medium frame, new tires.\nPickup only.' },
    listing_photos: [{ image: { uri: `${imageBase}/p1.png` } }, { image: { uri: `${imageBase}/p2.png` } }],
    location_text: { text: 'Brooklyn, NY' },
    location: { latitude: 40.67, longitude: -73.94 },
    attribute_data: [{ attribute_name: 'Condition', label: 'Used - Good' }],
    delivery_types: ['IN_PERSON'],
  };
  const messaged = state.messaged;
  return `<!doctype html><html><head><meta property="og:title" content="Trek FX 2"><style>[contenteditable]{display:block;min-height:20px}</style></head><body>
  <div role="banner"><a href="/">Facebook</a></div>
  <div role="main">
    <h1>Trek FX 2 Hybrid Bike</h1><div>$350</div><div>Listed 3 days ago in Brooklyn, NY</div>
    <div role="button" aria-label="${state.saved ? 'Unsave' : 'Save'}" tabindex="0" onclick="fetch('/save-toggle').then(()=>{this.setAttribute('aria-label', this.getAttribute('aria-label')==='Save'?'Unsave':'Save')})">Save</div>
    <div id="msgbox">${
      messaged
        ? '<div role="button" aria-label="Message again" tabindex="0" onclick="openChat()">Message again</div>'
        : `<span>Send seller a message</span><textarea aria-label="Message">Is this still available?</textarea>
           <div role="button" aria-label="Send" tabindex="0" onclick="sendFirst()">Send</div>`
    }</div>
    <div>Details</div><div>Condition</div><div>Used - Good</div><div>Medium frame, new tires.</div>
    <div>Seller information</div><a href="/marketplace/profile/9111/">Jane Doe</a><div>Joined Facebook in 2012</div>
  </div>
  <div id="chats"></div>
  ${relayScript({ viewer: { marketplace_product_details_page: { target: head } } })}
  ${relayScript({ node: detail })}
  <script>
    function bubble(text, who) {
      const d = document.createElement('div');
      d.setAttribute('aria-label', 'Message sent 4:01 PM by ' + who + ': ' + text);
      d.textContent = text; return d;
    }
    async function sendFirst() {
      const text = document.querySelector('#msgbox textarea').value;
      await fetch('/send?text=' + encodeURIComponent(text));
      document.getElementById('msgbox').innerHTML = '<div role="button" aria-label="Message again" tabindex="0" onclick="openChat()">Message again</div>';
    }
    async function openChat() {
      const hist = await (await fetch('/history')).json();
      const c = document.getElementById('chats');
      c.innerHTML = '<div class="chat"><div class="log"></div><div role="textbox" contenteditable="true" aria-label="Write to Jane Doe · Trek FX 2 Hybrid Bike"></div></div>';
      const log = c.querySelector('.log');
      hist.forEach(m => log.appendChild(bubble(m.text, m.who)));
      const box = c.querySelector('[role=textbox]');
      box.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const t = box.innerText; box.innerText = '';
          await fetch('/send?text=' + encodeURIComponent(t));
          log.appendChild(bubble(t, 'You'));
        }
      });
    }
  </script></body></html>`;
}

function profilePage() {
  return `<!doctype html><html><body><div role="main"><h1>Jane Doe</h1><div>4.8 (25)</div><div>Joined Facebook in 2012</div><div>Highly rated</div>
  ${card('111', ['$350', 'Trek FX 2 Hybrid Bike', 'Brooklyn, NY'])}
  ${card('555', ['$20', 'Helmet', 'Brooklyn, NY'])}</div></body></html>`;
}

function inboxPage() {
  return `<!doctype html><html><body><div role="main"><div role="tablist"><a role="tab" href="#">Buying</a><a role="tab" href="#">Selling</a></div>
  <a href="/messages/t/777/" aria-label="Unread conversation"><span>Jane Doe</span><br><span>Trek FX 2 Hybrid Bike</span><br><span>Sure, come by at 5 · 2h</span></a>
  <a href="/messages/t/888/"><span>Bob</span><br><span>Helmet</span><br><span>You: thanks! · 1d</span></a>
  <a href="/messages/t/777/"><span>Jane Doe</span></a></div></body></html>`;
}

function threadPage(state) {
  return `<!doctype html><html><head><style>[contenteditable]{display:block;min-height:20px}</style></head><body><div role="main">
  <a href="/marketplace/item/111/">Trek FX 2 Hybrid Bike</a>
  <div class="log">${state.history.map((m) => `<div aria-label="Message sent 4:01 PM by ${m.who}: ${m.text}">${m.text}</div>`).join('')}</div>
  <div role="textbox" contenteditable="true" aria-label="Message"></div></div>
  <script>
    const box = document.querySelector('[role=textbox]');
    box.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); const t = box.innerText; box.innerText = '';
        await fetch('/send?text=' + encodeURIComponent(t));
        const d = document.createElement('div'); d.setAttribute('aria-label', 'Message sent now by You: ' + t); d.textContent = t;
        document.querySelector('.log').appendChild(d);
      }
    });
  </script></body></html>`;
}

function createPage() {
  return `<!doctype html><html><body><div role="main"><form onsubmit="return false">
  <input type="file" accept="image/*" multiple id="photos">
  <label><span>Title</span><input type="text" id="title"></label>
  <label><span>Price</span><input type="text" id="price"></label>
  <div role="combobox" aria-label="Category" tabindex="0" id="cat" onclick="document.getElementById('catlist').hidden=false">Category</div>
  <div role="listbox" id="catlist" hidden><div role="option" onclick="pick('cat',this)">Furniture</div><div role="option" onclick="pick('cat',this)">Electronics &amp; computers</div></div>
  <div role="combobox" aria-label="Condition" tabindex="0" id="cond" onclick="document.getElementById('condlist').hidden=false">Condition</div>
  <div role="listbox" id="condlist" hidden><div role="option" onclick="pick('cond',this)">New</div><div role="option" onclick="pick('cond',this)">Used - Good</div></div>
  <label><span>Description</span><textarea id="desc"></textarea></label>
  <div role="button" aria-label="Next" tabindex="0" onclick="this.remove(); document.getElementById('pub').hidden=false">Next</div>
  <div role="button" aria-label="Publish" tabindex="0" id="pub" hidden onclick="fetch('/published').then(()=>location.href='/marketplace/you/selling/')">Publish</div>
  </form></div>
  <script>function pick(id, el){ document.getElementById(id).textContent = el.textContent; el.parentElement.hidden = true; }</script></body></html>`;
}

function sellingPage() {
  return `<!doctype html><html><body><div role="main"><h1>Your listings</h1>
  <div>Oak desk</div><div>$120</div><div>Active</div><div>· Listed on 10/28</div><div>34 clicks on listing</div><div>Mark as sold</div><div>Share</div>
  <div>Lamp</div><div>$15</div><div>Sold</div><div>Mark as available</div></div></body></html>`;
}

export async function installMockFacebook(ctx, { imageBase }) {
  const state = { messaged: false, saved: false, sent: [], history: [{ who: 'Jane Doe', text: 'Hi! Yes it is.' }], published: false };
  await ctx.route('https://www.facebook.com/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const html = (body) => route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    if (p.startsWith('/api/graphql')) return route.fulfill({ contentType: 'text/html', body: graphqlPage2() });
    if (p === '/send') {
      state.sent.push(url.searchParams.get('text'));
      state.history.push({ who: 'You', text: url.searchParams.get('text') });
      state.messaged = true;
      return route.fulfill({ body: 'ok' });
    }
    if (p === '/history') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.history) });
    if (p === '/save-toggle') {
      state.saved = !state.saved;
      return route.fulfill({ body: 'ok' });
    }
    if (p === '/published') {
      state.published = true;
      return route.fulfill({ body: 'ok' });
    }
    if (p.startsWith('/marketplace/blocked')) return route.fulfill({ status: 302, headers: { location: 'https://www.facebook.com/login/' } });
    if (p.startsWith('/login')) return html('<h1>Log in</h1>');
    if (p.startsWith('/marketplace/item/')) return html(itemPage(imageBase, state));
    if (p.startsWith('/marketplace/profile/')) return html(profilePage());
    if (p.startsWith('/marketplace/inbox')) return html(inboxPage());
    if (p.startsWith('/messages/t/')) return html(threadPage(state));
    if (p.startsWith('/marketplace/create')) return html(createPage());
    if (p.startsWith('/marketplace/you/selling')) return html(sellingPage());
    if (p.startsWith('/marketplace/you/saved')) return html(`<div role="main">${card('111', ['$350', 'Trek FX 2 Hybrid Bike', 'Brooklyn, NY'])}</div>`);
    return html(searchPage());
  });
  return state;
}
