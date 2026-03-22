const COMMENT_WORK_IDS = new Set(['paulus-fruehchristentum', 'johannes-textvarianten'])
const WORK_IDS_ALLOWED = new Set([
  'markus-historisch',
  'paulus-fruehchristentum',
  'johannes-textvarianten',
])

let commentReplyParentId = null

/** Dynamischer Import verhindert, dass Vite Supabase bei leerem .env komplett entfernt. */
async function getSupabase() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = import.meta.env.VITE_SUPABASE_URL || ''
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
  if (!url || !key) return null
  return createClient(url, key)
}

function handleImageError(element) {
  element.src =
    'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?auto=format&fit=crop&q=80&w=800'
}

function escapeHtml(s) {
  const d = document.createElement('div')
  d.textContent = s == null ? '' : String(s)
  return d.innerHTML
}

function formatCommentDate(iso) {
  try {
    return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return ''
  }
}

function buildTree(rows) {
  const byId = new Map()
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      body: r.body,
      authorLabel: (r.author_name && String(r.author_name).trim()) || 'Anonym',
      createdAt: r.created_at,
      replies: [],
    })
  }
  const roots = []
  for (const r of rows) {
    const node = byId.get(r.id)
    if (r.parent_id) {
      const parent = byId.get(r.parent_id)
      if (parent) parent.replies.push(node)
      else roots.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortRec = (list) => {
    list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    list.forEach((n) => sortRec(n.replies))
  }
  sortRec(roots)
  return roots
}

function openDetail(workId, title, description, status) {
  document.getElementById('detail-work-id').value = workId
  document.getElementById('detail-title').innerText = title
  document.getElementById('detail-description').innerText = description
  document.getElementById('detail-status').innerHTML =
    `<span class="status-badge border-stone-200 text-stone-500">${escapeHtml(status)}</span>`
  document.getElementById('detail-view').style.display = 'block'
  document.body.style.overflow = 'hidden'
  window.scrollTo({ top: 0 })

  const wrap = document.getElementById('comments-section-wrap')
  if (COMMENT_WORK_IDS.has(workId)) {
    wrap.classList.remove('hidden')
    loadComments()
  } else {
    wrap.classList.add('hidden')
  }
}

function closeDetail() {
  closeCommentModal()
  document.getElementById('detail-view').style.display = 'none'
  document.body.style.overflow = 'auto'
}

function renderCommentBranch(c) {
  const article = document.createElement('article')
  article.className = 'comment-card'
  const meta = document.createElement('div')
  meta.className = 'flex flex-wrap items-baseline gap-2 text-sm'
  meta.innerHTML =
    '<span class="font-semibold text-black">' +
    escapeHtml(c.authorLabel) +
    '</span><time class="text-xs text-gray-400">' +
    escapeHtml(formatCommentDate(c.createdAt)) +
    '</time>'
  const p = document.createElement('p')
  p.className = 'text-gray-700 leading-relaxed mt-2 whitespace-pre-wrap'
  p.textContent = c.body
  const replyBtn = document.createElement('button')
  replyBtn.type = 'button'
  replyBtn.className = 'mt-3 text-[10px] uppercase tracking-widest text-stone-500 hover:text-black'
  replyBtn.textContent = 'Antworten'
  replyBtn.addEventListener('click', () => {
    openCommentModal(c.id)
  })
  article.appendChild(meta)
  article.appendChild(p)
  article.appendChild(replyBtn)
  if (c.replies && c.replies.length) {
    const repliesWrap = document.createElement('div')
    repliesWrap.className = 'comment-replies space-y-4'
    c.replies.forEach((r) => {
      repliesWrap.appendChild(renderCommentBranch(r))
    })
    article.appendChild(repliesWrap)
  }
  return article
}

async function loadComments() {
  const workId = document.getElementById('detail-work-id').value
  const list = document.getElementById('comments-list')
  const statusEl = document.getElementById('comments-status')
  list.innerHTML = ''
  statusEl.classList.add('hidden')
  statusEl.textContent = ''

  const supabase = await getSupabase()
  if (!supabase) {
    statusEl.textContent =
      'Kommentare: Bitte VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY setzen (z. B. in Vercel unter Environment Variables).'
    statusEl.classList.remove('hidden')
    return
  }

  try {
    const { data, error } = await supabase
      .from('work_comments')
      .select('id, work_id, parent_id, body, author_name, created_at')
      .eq('work_id', workId)
      .order('created_at', { ascending: true })

    if (error) {
      statusEl.textContent = 'Kommentare konnten nicht geladen werden.'
      statusEl.classList.remove('hidden')
      return
    }

    const tree = buildTree(data || [])
    if (tree.length === 0) {
      list.innerHTML = '<p class="text-sm text-gray-400 italic">Noch keine Kommentare.</p>'
      return
    }
    tree.forEach((c) => {
      list.appendChild(renderCommentBranch(c))
    })
  } catch {
    statusEl.textContent = 'Kommentare sind hier nicht erreichbar.'
    statusEl.classList.remove('hidden')
  }
}

function openCommentModal(parentId) {
  commentReplyParentId = parentId || null
  const modal = document.getElementById('comment-modal')
  const h = document.getElementById('comment-modal-heading')
  h.textContent = commentReplyParentId ? 'Antwort schreiben' : 'Kommentar hinzufügen'
  document.getElementById('comment-modal-text').value = ''
  document.getElementById('comment-modal-name').value = ''
  modal.classList.add('is-open')
  document.getElementById('comment-modal-text').focus()
}

function closeCommentModal() {
  document.getElementById('comment-modal').classList.remove('is-open')
  commentReplyParentId = null
}

async function submitComment() {
  const workId = document.getElementById('detail-work-id').value
  const text = document.getElementById('comment-modal-text').value.trim()
  const name = document.getElementById('comment-modal-name').value.trim()
  if (!text) return

  if (!WORK_IDS_ALLOWED.has(workId)) {
    alert('Ungültige Arbeit.')
    return
  }

  const btn = document.getElementById('comment-modal-submit')
  btn.disabled = true
  try {
    const supabase = await getSupabase()
    if (!supabase) {
      alert('Kommentare sind nicht konfiguriert.')
      return
    }

    const row = {
      work_id: workId,
      parent_id: commentReplyParentId,
      body: text.slice(0, 4000),
      author_name: name ? name.slice(0, 80) : null,
    }

    const { error } = await supabase.from('work_comments').insert(row)

    if (error) {
      alert('Senden fehlgeschlagen. Bitte später erneut versuchen.')
      return
    }
    closeCommentModal()
    loadComments()
  } catch {
    alert('Netzwerkfehler — bitte später erneut versuchen.')
  } finally {
    btn.disabled = false
  }
}

document.getElementById('btn-add-comment').addEventListener('click', () => {
  openCommentModal(null)
})
document.getElementById('comment-modal-cancel').addEventListener('click', closeCommentModal)
document.getElementById('comment-modal-submit').addEventListener('click', submitComment)
document.getElementById('comment-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('comment-modal')) closeCommentModal()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCommentModal()
})

const observerOptions = { threshold: 0.1 }
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('opacity-100', 'translate-y-0')
      entry.target.classList.remove('opacity-0', 'translate-y-10')
    }
  })
}, observerOptions)

document.querySelectorAll('section').forEach((section) => {
  section.classList.add('section-fade', 'opacity-0', 'translate-y-10')
  observer.observe(section)
})

;(function () {
  const btn = document.getElementById('mobile-menu-btn')
  const menu = document.getElementById('mobile-menu')
  if (!btn || !menu) return
  btn.addEventListener('click', () => {
    const open = menu.classList.toggle('hidden')
    btn.setAttribute('aria-expanded', String(!open))
  })
  menu.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      menu.classList.add('hidden')
      btn.setAttribute('aria-expanded', 'false')
    })
  })
})()

window.handleImageError = handleImageError
window.openDetail = openDetail
window.closeDetail = closeDetail
