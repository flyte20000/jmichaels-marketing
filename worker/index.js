// J Michael's Marketing HQ — Cloudflare Worker API
// Routes: /api/auth, /api/users, /api/posts, /api/scores, /api/reminders,
//         /api/approvals, /api/library, /api/campaigns, /api/notifications, /api/invites
//         /api/images (R2 upload/list/delete)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

async function hashPassword(pw) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(pw + 'jm_s2024')
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function randId(n = 16) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getUser(db, req) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  const row = await db
    .prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
    .bind(token, Date.now())
    .first();
  if (!row) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(row.user_id).first();
}

const R2_PUBLIC = 'https://pub-b540bc5bd3f045e48222d8f8228a5f02.r2.dev';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const method = request.method;
    const db = env.DB;

    // Body helper — skip for multipart uploads
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(method) && !request.headers.get('content-type')?.includes('multipart')) {
      try { body = await request.json(); } catch {}
    }

    // ── AUTH ────────────────────────────────────────────────────────────────
    if (path === '/api/auth/login' && method === 'POST') {
      const { username, password } = body;
      if (!username || !password) return err('Username and password required');
      const user = await db
        .prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)')
        .bind(username)
        .first();
      if (!user) return err('User not found', 401);
      const h = await hashPassword(password);
      if (h !== user.password_hash) return err('Incorrect password', 401);
      const token = randId();
      const expires = Date.now() + 1000 * 60 * 60 * 24 * 30;
      await db
        .prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(token, user.id, expires)
        .run();
      return json({ token, user: { id: user.id, username: user.username, role: user.role } });
    }

    if (path === '/api/auth/register' && method === 'POST') {
      const { invite_code, username, password } = body;
      if (!invite_code || !username || !password) return err('All fields required');
      const inv = await db
        .prepare('SELECT * FROM invites WHERE code = ? AND used = 0 AND expires_at > ?')
        .bind(invite_code, Date.now())
        .first();
      if (!inv) return err('Invalid or expired invite code', 403);
      const existing = await db
        .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)')
        .bind(username)
        .first();
      if (existing) return err('Username already taken');
      const h = await hashPassword(password);
      const id = randId(8);
      await db
        .prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, username, h, inv.role, new Date().toISOString())
        .run();
      await db.prepare('UPDATE invites SET used = 1, used_by = ? WHERE id = ?').bind(username, inv.id).run();
      return json({ success: true });
    }

    if (path === '/api/auth/me' && method === 'GET') {
      const user = await getUser(db, request);
      if (!user) return err('Unauthorized', 401);
      return json({ id: user.id, username: user.username, role: user.role });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace('Bearer ', '').trim();
      if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return json({ success: true });
    }

    // All routes below require auth
    const user = await getUser(db, request);
    if (!user) return err('Unauthorized', 401);

    // ── AI (Claude proxy) ────────────────────────────────────────────────────
    if (path === '/api/ai/generate' && method === 'POST') {
      const { system, prompt, max_tokens } = body;
      if (!prompt) return err('Prompt required');
      if (!env.ANTHROPIC_API_KEY) return err('AI not configured', 500);
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: max_tokens || 1000,
            system: system || 'You are a helpful assistant.',
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const data = await r.json();
        if (!r.ok) return err(data.error?.message || 'AI request failed', r.status);
        const text = data.content?.map(c => c.text || '').join('') || '';
        return json({ text });
      } catch (e) {
        return err('AI error: ' + e.message, 500);
      }
    }

    // ── IMAGES (R2) ──────────────────────────────────────────────────────────
    if (path === '/api/images' && method === 'GET') {
      const folder = url.searchParams.get('folder') || '';
      const prefix = folder ? `photos/${folder}/` : 'photos/';
      const list = await env.IMAGES.list({ prefix });
      const images = list.objects
        .filter(obj => !obj.key.endsWith('/.folder'))
        .map(obj => {
          const parts = obj.key.split('/');
          const fname = parts[parts.length - 1];
          const fld = parts.length >= 3 ? parts.slice(1, -1).join('/') : '';
          return {
            key: obj.key,
            url: `${R2_PUBLIC}/${obj.key}`,
            size: obj.size,
            uploaded: obj.uploaded,
            name: obj.customMetadata?.originalName || fname,
            uploadedBy: obj.customMetadata?.uploadedBy || '',
            folder: fld,
          };
        });
      return json(images.reverse());
    }

    if (path === '/api/images/upload' && method === 'POST') {
      const formData = await request.formData();
      const file = formData.get('file');
      const folder = (formData.get('folder') || 'Inbox').toString().trim() || 'Inbox';
      if (!file) return err('No file provided');
      const ext = file.name.split('.').pop().toLowerCase();
      const allowed = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
      if (!allowed.includes(ext)) return err('Invalid file type. Use JPG, PNG, GIF or WebP');
      if (file.size > 10 * 1024 * 1024) return err('File too large. Max 10MB');
      const safeFolder = folder.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 60) || 'Inbox';
      const key = `photos/${safeFolder}/${Date.now()}-${randId(6)}.${ext}`;
      await env.IMAGES.put(key, file.stream(), {
        httpMetadata: { contentType: file.type },
        customMetadata: { uploadedBy: user.username, originalName: file.name, folder: safeFolder },
      });
      return json({ success: true, key, url: `${R2_PUBLIC}/${key}`, name: file.name, folder: safeFolder });
    }

    if (path.startsWith('/api/images/') && path.endsWith('/move') && method === 'POST') {
      const key = decodeURIComponent(path.slice('/api/images/'.length, -('/move'.length)));
      const { folder } = body;
      if (!folder) return err('Target folder required');
      const safeFolder = String(folder).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 60);
      if (!safeFolder) return err('Invalid folder name');
      const obj = await env.IMAGES.get(key);
      if (!obj) return err('Photo not found at key: ' + key, 404);
      const fname = key.split('/').pop();
      const newKey = `photos/${safeFolder}/${fname}`;
      if (newKey === key) return json({ success: true, key, url: `${R2_PUBLIC}/${key}`, note: 'already in folder' });
      const oldUrl = `${R2_PUBLIC}/${key}`;
      const newUrl = `${R2_PUBLIC}/${newKey}`;
      const md = obj.customMetadata || {};
      md.folder = safeFolder;
      try {
        // Fully buffer the body so put() doesn't race with anything
        const buf = await obj.arrayBuffer();
        await env.IMAGES.put(newKey, buf, {
          httpMetadata: obj.httpMetadata,
          customMetadata: md,
        });
      } catch (e) {
        return err('Failed to write new photo: ' + e.message, 500);
      }
      try {
        await env.IMAGES.delete(key);
      } catch (e) {
        return err('Wrote new photo but failed to delete old: ' + e.message, 500);
      }
      // Verify the delete actually took effect
      const check = await env.IMAGES.head(key);
      if (check) {
        return err('Delete reported success but old photo is still present at: ' + key, 500);
      }
      // Update any DB rows that reference the old URL so they don't 404
      await Promise.all([
        db.prepare('UPDATE posts SET image_url=? WHERE image_url=?').bind(newUrl, oldUrl).run(),
        db.prepare('UPDATE library SET image_url=? WHERE image_url=?').bind(newUrl, oldUrl).run(),
        db.prepare('UPDATE approvals SET image_url=? WHERE image_url=?').bind(newUrl, oldUrl).run(),
      ]);
      return json({ success: true, key: newKey, url: newUrl, folder: safeFolder });
    }

    // ── PHOTO FOLDERS ────────────────────────────────────────────────────────
    if (path === '/api/folders' && method === 'GET') {
      const { results: folders } = await db.prepare('SELECT name, created_by, created_at FROM photo_folders ORDER BY name').all();
      const list = await env.IMAGES.list({ prefix: 'photos/' });
      const counts = {};
      for (const obj of list.objects) {
        if (obj.key.endsWith('/.folder')) continue;
        const parts = obj.key.split('/');
        if (parts.length >= 3) {
          const f = parts.slice(1, -1).join('/');
          counts[f] = (counts[f] || 0) + 1;
        }
      }
      return json(folders.map(f => ({ ...f, count: counts[f.name] || 0 })));
    }

    if (path === '/api/folders' && method === 'POST') {
      if (user.role !== 'admin') return err('Admin only', 403);
      const raw = (body.name || '').toString().trim();
      const name = raw.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 60);
      if (!name) return err('Folder name required (letters, numbers, spaces, _ or - only)');
      const existing = await db.prepare('SELECT name FROM photo_folders WHERE name = ?').bind(name).first();
      if (existing) return err('Folder already exists');
      await db.prepare('INSERT INTO photo_folders (name, created_by, created_at) VALUES (?, ?, ?)').bind(name, user.username, new Date().toISOString()).run();
      return json({ success: true, name });
    }

    if (path.startsWith('/api/folders/') && method === 'DELETE') {
      if (user.role !== 'admin') return err('Admin only', 403);
      const name = decodeURIComponent(path.slice('/api/folders/'.length));
      if (name === 'Inbox') return err('Cannot delete the default Inbox folder');
      const list = await env.IMAGES.list({ prefix: `photos/${name}/` });
      const real = list.objects.filter(o => !o.key.endsWith('/.folder'));
      if (real.length) return err(`Folder is not empty (${real.length} photo${real.length>1?'s':''}). Move or delete the photos first.`, 409);
      await db.prepare('DELETE FROM photo_folders WHERE name = ?').bind(name).run();
      return json({ success: true });
    }

    if (path.startsWith('/api/folders/') && method === 'PUT') {
      if (user.role !== 'admin') return err('Admin only', 403);
      const oldName = decodeURIComponent(path.slice('/api/folders/'.length));
      const raw = (body.name || '').toString().trim();
      const newName = raw.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 60);
      if (!newName) return err('New name required');
      if (newName === oldName) return json({ success: true, name: newName });
      const exists = await db.prepare('SELECT name FROM photo_folders WHERE name = ?').bind(newName).first();
      if (exists) return err('A folder with that name already exists');
      // Move all R2 objects under photos/<oldName>/ to photos/<newName>/
      const list = await env.IMAGES.list({ prefix: `photos/${oldName}/` });
      for (const obj of list.objects) {
        if (obj.key.endsWith('/.folder')) continue;
        const fname = obj.key.split('/').pop();
        const newKey = `photos/${newName}/${fname}`;
        const src = await env.IMAGES.get(obj.key);
        if (!src) continue;
        const md = src.customMetadata || {};
        md.folder = newName;
        await env.IMAGES.put(newKey, src.body, { httpMetadata: src.httpMetadata, customMetadata: md });
        await env.IMAGES.delete(obj.key);
        const oldUrl = `${R2_PUBLIC}/${obj.key}`;
        const newUrl = `${R2_PUBLIC}/${newKey}`;
        await Promise.all([
          db.prepare('UPDATE posts SET image_url=? WHERE image_url=?').bind(newUrl, oldUrl).run(),
          db.prepare('UPDATE library SET image_url=? WHERE image_url=?').bind(newUrl, oldUrl).run(),
          db.prepare('UPDATE approvals SET image_url=? WHERE image_url=?').bind(newUrl, oldUrl).run(),
        ]);
      }
      await db.prepare('UPDATE photo_folders SET name = ? WHERE name = ?').bind(newName, oldName).run();
      return json({ success: true, name: newName });
    }

    if (path.startsWith('/api/images/') && method === 'DELETE') {
      if (user.role !== 'admin') return err('Admin only', 403);
      const key = decodeURIComponent(path.slice('/api/images/'.length));
      const fullUrl = `${R2_PUBLIC}/${key}`;
      // Block deletion if the photo is referenced by any post, library item, or approval
      const [postsRef, libRef, apprRef] = await Promise.all([
        db.prepare('SELECT COUNT(*) AS n FROM posts WHERE image_url = ?').bind(fullUrl).first(),
        db.prepare('SELECT COUNT(*) AS n FROM library WHERE image_url = ?').bind(fullUrl).first(),
        db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE image_url = ?').bind(fullUrl).first(),
      ]);
      const inUse = [];
      if (postsRef.n > 0) inUse.push(`${postsRef.n} calendar post${postsRef.n>1?'s':''}`);
      if (libRef.n > 0) inUse.push(`${libRef.n} library item${libRef.n>1?'s':''}`);
      if (apprRef.n > 0) inUse.push(`${apprRef.n} approval${apprRef.n>1?'s':''}`);
      if (inUse.length) {
        return json({ error: `This photo is attached to ${inUse.join(', ')}. Delete those first, then you can remove the photo.` }, 409);
      }
      await env.IMAGES.delete(key);
      return json({ success: true });
    }

    // ── USERS ────────────────────────────────────────────────────────────────
    if (path === '/api/users' && method === 'GET') {
      if (user.role !== 'admin') return err('Forbidden', 403);
      const { results } = await db
        .prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC')
        .all();
      return json(results);
    }

    if (path === '/api/users' && method === 'POST') {
      if (user.role !== 'admin') return err('Forbidden', 403);
      const { username, password, role } = body;
      if (!username || !password) return err('Username and password required');
      const existing = await db
        .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)')
        .bind(username)
        .first();
      if (existing) return err('Username already exists');
      const h = await hashPassword(password);
      const id = randId(8);
      await db
        .prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, username, h, role || 'staff', new Date().toISOString())
        .run();
      return json({ success: true, id });
    }

    if (path.startsWith('/api/users/') && method === 'DELETE') {
      if (user.role !== 'admin') return err('Forbidden', 403);
      const uid = path.split('/')[3];
      if (uid === user.id) return err('Cannot delete yourself');
      await db.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
      return json({ success: true });
    }

    if (path === '/api/users/password' && method === 'PUT') {
      const { current_password, new_password } = body;
      if (!current_password || !new_password) return err('Both passwords required');
      const h = await hashPassword(current_password);
      if (h !== user.password_hash) return err('Current password incorrect', 401);
      const nh = await hashPassword(new_password);
      await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(nh, user.id).run();
      return json({ success: true });
    }

    // ── INVITES ──────────────────────────────────────────────────────────────
    if (path === '/api/invites' && method === 'GET') {
      if (user.role !== 'admin') return err('Forbidden', 403);
      const { results } = await db
        .prepare('SELECT * FROM invites WHERE used = 0 AND expires_at > ? ORDER BY created_at DESC')
        .bind(Date.now())
        .all();
      return json(results);
    }

    if (path === '/api/invites' && method === 'POST') {
      if (user.role !== 'admin') return err('Forbidden', 403);
      const { role, days } = body;
      const code = randId(6);
      const expires = Date.now() + (days || 7) * 86400000;
      const id = randId(8);
      await db
        .prepare('INSERT INTO invites (id, code, role, expires_at, created_by, used, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
        .bind(id, code, role || 'staff', expires, user.username, new Date().toISOString())
        .run();
      return json({ code, expires_at: expires });
    }

    // ── POSTS ────────────────────────────────────────────────────────────────
    if (path === '/api/posts' && method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM posts ORDER BY date ASC')
        .all();
      return json(results);
    }

    if (path === '/api/posts' && method === 'POST') {
      const { date, platform, content, status, image_url } = body;
      if (!date || !content) return err('Date and content required');
      const id = randId(8);
      await db
        .prepare('INSERT INTO posts (id, date, platform, content, status, image_url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, date, platform || 'fb', content, status || 'draft', image_url || '', user.username, new Date().toISOString())
        .run();
      return json({ success: true, id });
    }

    if (path.startsWith('/api/posts/') && method === 'PUT') {
      const id = path.split('/')[3];
      const { date, platform, content, status, image_url } = body;
      if (image_url !== undefined) {
        await db
          .prepare('UPDATE posts SET date=?, platform=?, content=?, status=?, image_url=? WHERE id=?')
          .bind(date, platform, content, status, image_url || '', id)
          .run();
      } else {
        await db
          .prepare('UPDATE posts SET date=?, platform=?, content=?, status=? WHERE id=?')
          .bind(date, platform, content, status, id)
          .run();
      }
      return json({ success: true });
    }

    if (path.startsWith('/api/posts/') && method === 'DELETE') {
      const id = path.split('/')[3];
      await db.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
      return json({ success: true });
    }

    // ── SCORES ───────────────────────────────────────────────────────────────
    if (path === '/api/scores' && method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM scores ORDER BY created_at DESC LIMIT 50')
        .all();
      return json(results);
    }

    if (path === '/api/scores' && method === 'POST') {
      const { content, platform, overall, grade, breakdown, strengths, improvements, best_time, rewrite_tip } = body;
      const id = randId(8);
      await db
        .prepare('INSERT INTO scores (id, content_preview, platform, overall, grade, breakdown, strengths, improvements, best_time, rewrite_tip, scored_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, (content||'').substring(0,100), platform, overall, grade,
          JSON.stringify(breakdown||{}), JSON.stringify(strengths||[]),
          JSON.stringify(improvements||[]), best_time||'', rewrite_tip||'',
          user.username, new Date().toISOString())
        .run();
      return json({ success: true, id });
    }

    // ── REMINDERS ────────────────────────────────────────────────────────────
    if (path === '/api/reminders' && method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM reminders ORDER BY due_at ASC')
        .all();
      return json(results);
    }

    if (path === '/api/reminders' && method === 'POST') {
      const { title, type, due_at, priority, notes } = body;
      if (!title || !due_at) return err('Title and due date required');
      const id = randId(8);
      await db
        .prepare('INSERT INTO reminders (id, title, type, due_at, priority, notes, done, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
        .bind(id, title, type||'custom', due_at, priority||'medium', notes||'', user.username, new Date().toISOString())
        .run();
      return json({ success: true, id });
    }

    if (path.startsWith('/api/reminders/') && method === 'PUT') {
      const id = path.split('/')[3];
      const { done } = body;
      await db
        .prepare('UPDATE reminders SET done=?, completed_at=? WHERE id=?')
        .bind(done ? 1 : 0, done ? new Date().toISOString() : null, id)
        .run();
      return json({ success: true });
    }

    if (path.startsWith('/api/reminders/') && method === 'DELETE') {
      const id = path.split('/')[3];
      await db.prepare('DELETE FROM reminders WHERE id = ?').bind(id).run();
      return json({ success: true });
    }

    // ── APPROVALS ────────────────────────────────────────────────────────────
    if (path === '/api/approvals' && method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM approvals ORDER BY submitted_at DESC')
        .all();
      return json(results);
    }

    if (path === '/api/approvals' && method === 'POST') {
      const { content, platform, image_url } = body;
      if (!content) return err('Content required');
      const id = randId(8);
      await db
        .prepare('INSERT INTO approvals (id, content, platform, status, submitted_by, submitted_at, image_url) VALUES (?, ?, ?, "pending", ?, ?, ?)')
        .bind(id, content, platform||'', user.username, new Date().toISOString(), image_url || '')
        .run();
      return json({ success: true, id });
    }

    if (path.startsWith('/api/approvals/') && method === 'PUT') {
      if (user.role !== 'admin') return err('Forbidden', 403);
      const id = path.split('/')[3];
      const { status } = body;
      await db
        .prepare('UPDATE approvals SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?')
        .bind(status, user.username, new Date().toISOString(), id)
        .run();
      return json({ success: true });
    }

    // ── LIBRARY ──────────────────────────────────────────────────────────────
    if (path === '/api/library' && method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM library ORDER BY saved_at DESC')
        .all();
      return json(results);
    }

    if (path === '/api/library' && method === 'POST') {
      const { content, platform, image_url } = body;
      if (!content) return err('Content required');
      const id = randId(8);
      await db
        .prepare('INSERT INTO library (id, content, platform, saved_by, saved_at, image_url) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, content, platform||'fb', user.username, new Date().toISOString(), image_url || '')
        .run();
      return json({ success: true, id });
    }

    if (path.startsWith('/api/library/') && method === 'DELETE') {
      const id = path.split('/')[3];
      await db.prepare('DELETE FROM library WHERE id = ?').bind(id).run();
      return json({ success: true });
    }

    // ── CAMPAIGNS ────────────────────────────────────────────────────────────
    if (path === '/api/campaigns' && method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM campaigns ORDER BY start_date ASC')
        .all();
      return json(results);
    }

    if (path === '/api/campaigns' && method === 'POST') {
      const { name, goal, start_date, end_date, description } = body;
      if (!name) return err('Campaign name required');
      const id = randId(8);
      await db
        .prepare('INSERT INTO campaigns (id, name, goal, start_date, end_date, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, name, goal||'', start_date||'', end_date||'', description||'', user.username, new Date().toISOString())
        .run();
      return json({ success: true, id });
    }

    // ── NOTIFICATIONS ─────────────────────────────────────────────────────────
    if (path === '/api/notifications' && method === 'GET') {
      const { results } = await db
        .prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50')
        .all();
      return json(results);
    }

    if (path === '/api/notifications' && method === 'POST') {
      const { title, description, type } = body;
      const id = randId(8);
      await db
        .prepare('INSERT INTO notifications (id, title, description, type, read, created_at) VALUES (?, ?, ?, ?, 0, ?)')
        .bind(id, title, description||'', type||'info', new Date().toISOString())
        .run();
      return json({ success: true });
    }

    if (path === '/api/notifications/read-all' && method === 'PUT') {
      await db.prepare('UPDATE notifications SET read = 1').run();
      return json({ success: true });
    }

    return err('Not found', 404);
  },
};
