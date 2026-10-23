const searchInput = document.querySelector('#course-search');
const emptySearch = document.querySelector('#empty-search');
const courseGrid = document.querySelector('#course-grid');
const toast = document.querySelector('#toast');
const appShell = document.querySelector('.app-shell');
const authScreen = document.querySelector('#auth-screen');
let currentUser = null;
let activeCourse = null;
let activeLessonIndex = 0;
let activeMaterialId = null;
let toastTimer;

document.querySelector('#today-label').textContent = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
}).format(new Date()).toUpperCase();

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

const dateLabel = (value) => {
  if (/^[A-Z]{3,9} \d{1,2}$/.test(value)) return value.toUpperCase();
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric',
  }).format(date).toUpperCase();
};

async function loadAdminDashboard() {
  try {
    const [overviewResponse, coursesResponse, assignmentsResponse, classesResponse] = await Promise.all([
      fetch('/api/admin/overview'), fetch('/api/courses'), fetch('/api/assignments'), fetch('/api/classes'),
    ]);
    if (![overviewResponse, coursesResponse, assignmentsResponse, classesResponse].every((response) => response.ok)) {
      throw new Error('Dashboard data unavailable');
    }
    const [overview, courses, assignments, classes] = await Promise.all([
      overviewResponse.json(), coursesResponse.json(), assignmentsResponse.json(), classesResponse.json(),
    ]);
    document.querySelector('#course-total').textContent = overview.course_count;
    document.querySelector('#assignment-total').textContent = overview.assignment_count;
    document.querySelector('#completion-total').textContent = overview.completion_count;
    document.querySelector('#course-panel-count').textContent = `${courses.length} courses`;
    document.querySelector('#assignment-panel-count').textContent = `${assignments.length} items`;
    renderStudentCourses(courses);
    document.querySelector('#admin-course-list').innerHTML = courses.map((course) => `
      <div class="admin-record course-record"><strong>${escapeHtml(course.title)}</strong><span>${escapeHtml(course.code)}</span><span>${escapeHtml(course.instructor)}</span></div>
    `).join('');
    document.querySelector('#admin-assignment-list').innerHTML = assignments.map((assignment) => `
      <div class="admin-record assignment-record"><strong>${escapeHtml(assignment.title)}</strong><span>${escapeHtml(assignment.course)}</span><span>${escapeHtml(dateLabel(assignment.due))}</span><span class="record-status ${assignment.completed ? 'is-done' : ''}">${assignment.completed ? 'Done' : 'Open'}</span></div>
    `).join('');
    renderStudentAssignments(assignments);
    populateClassCourses(courses);
    populateMaterialCourses(courses);
    if (document.querySelector('#material-course').value) {
      await loadAdminMaterials(document.querySelector('#material-course').value);
    }
    renderOnlineClasses(classes, document.querySelector('#admin-class-list'));
    document.querySelector('#class-panel-count').textContent = `${classes.length} sessions`;
  } catch {
    showToast('Could not load the school workspace');
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderStudentAssignments(assignments) {
  const list = document.querySelector('.assignment-list');
  document.querySelector('#assignments .heading-count').textContent = String(assignments.length).padStart(2, '0');
  list.innerHTML = assignments.map((assignment) => `
    <label class="assignment-row" data-assignment-id="${escapeHtml(assignment.id)}">
      <input type="checkbox" ${assignment.completed ? 'checked' : ''}>
      <span class="task-check"></span>
      <span class="assignment-info"><strong>${escapeHtml(assignment.title)}</strong><small>${escapeHtml(assignment.course)} <span>·</span> ${escapeHtml(assignment.instructor)}</small></span>
      <span class="due-date">${escapeHtml(dateLabel(assignment.due))}</span>
    </label>
  `).join('');
}

function formatClassTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function classTimeState(value) {
  const start = new Date(value).valueOf();
  if (!Number.isFinite(start)) return 'Scheduled';
  return start <= Date.now() ? 'Ready to join' : 'Upcoming';
}

function renderOnlineClasses(classes, target) {
  const count = document.querySelector('#student-class-count');
  count.textContent = String(classes.length).padStart(2, '0');
  if (!classes.length) {
    target.innerHTML = '<p class="class-empty">No online classes scheduled yet.</p>';
    return;
  }
  target.innerHTML = classes.map((session) => `
    <article class="class-card">
      <div class="class-date-mark"><span>LIVE</span><strong>↗</strong></div>
      <div class="class-main"><span class="class-course">${escapeHtml(session.course)}</span><h3>${escapeHtml(session.title)}</h3><p>${escapeHtml(session.instructor)} <span>·</span> ${escapeHtml(formatClassTime(session.starts_at))}</p></div>
      <span class="class-state">${escapeHtml(classTimeState(session.starts_at))}</span>
      <a class="class-join" href="${escapeHtml(session.meeting_url)}" target="_blank" rel="noopener noreferrer">Join class <span>↗</span></a>
    </article>
  `).join('');
}

function populateClassCourses(courses) {
  const selector = document.querySelector('#class-course');
  const selected = selector.value;
  selector.innerHTML = '<option value="">Choose a course</option>' + courses.map((course) =>
    `<option value="${escapeHtml(course.title)}">${escapeHtml(course.code)} · ${escapeHtml(course.title)}</option>`
  ).join('');
  if (courses.some((course) => course.title === selected)) selector.value = selected;
}

function populateMaterialCourses(courses) {
  const selector = document.querySelector('#material-course');
  const selected = selector.value;
  selector.innerHTML = '<option value="">Choose a course</option>' + courses.map((course) =>
    `<option value="${escapeHtml(course.code)}">${escapeHtml(course.code)} · ${escapeHtml(course.title)}</option>`
  ).join('');
  if (courses.some((course) => course.code === selected)) selector.value = selected;
  else if (courses.length) selector.value = courses[0].code;
}

function renderMaterialLinks(materials, target, emptyMessage) {
  if (!materials.length) {
    target.innerHTML = `<p class="materials-empty">${emptyMessage}</p>`;
    return;
  }
  if (target.id === 'student-material-list') {
    target.innerHTML = materials.map((material) => `
      <div class="material-file-row ${material.id === activeMaterialId ? 'selected' : ''}">
        <button class="material-link material-select" type="button" data-material-id="${escapeHtml(material.id)}" aria-pressed="${material.id === activeMaterialId}">
          <span class="material-icon">PDF</span><span class="material-copy"><strong>${escapeHtml(material.name)}</strong><small>Preview in course</small></span>
        </button>
        <a class="material-download-link" href="${escapeHtml(material.download_url)}" download aria-label="Download ${escapeHtml(material.name)}" title="Download PDF">↓</a>
      </div>
    `).join('');
    return;
  }
  target.innerHTML = materials.map((material) => `
    <a class="material-link" href="${escapeHtml(material.download_url)}" target="_blank" rel="noopener noreferrer">
      <span class="material-icon">PDF</span><span class="material-copy"><strong>${escapeHtml(material.name)}</strong><small>PDF document</small></span><span class="material-download" aria-hidden="true">↓</span>
    </a>
  `).join('');
}

async function loadAdminMaterials(courseCode) {
  const list = document.querySelector('#admin-material-list');
  if (!courseCode) {
    list.innerHTML = '';
    return;
  }
  try {
    const response = await fetch(`/api/courses/${encodeURIComponent(courseCode)}`);
    const course = await response.json();
    if (!response.ok) throw new Error(course.error || 'Could not load course files');
    renderMaterialLinks(course.materials, list, 'No PDFs uploaded for this course yet.');
  } catch {
    list.innerHTML = '<p class="materials-empty">Could not load course files.</p>';
  }
}

function renderStudentCourses(courses) {
  const grid = document.querySelector('#course-grid');
  for (const course of courses) {
    const existingCard = grid.querySelector(`[data-course-code="${CSS.escape(course.code)}"]`);
    if (existingCard) {
      updateCourseCard(existingCard, course);
      continue;
    }
    const card = document.createElement('article');
    card.className = 'course-card added-course-card';
    card.dataset.courseCode = course.code;
    card.dataset.search = `${course.title} ${course.code} ${course.instructor}`.toLowerCase();
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${course.title}`);
    card.innerHTML = `
      <div class="course-image image-new-course"><span class="new-course-mark">${escapeHtml(course.code.split(/\s+/)[0])}</span><span class="course-tag">NEW COURSE</span><button class="bookmark-button" aria-label="Bookmark ${escapeHtml(course.title)}" data-toast="${escapeHtml(course.title)} saved">♡</button></div>
      <div class="course-body"><div class="course-meta"><span>${escapeHtml(course.code)}</span><span>·</span><span>${escapeHtml(course.instructor)}</span></div><h3>${escapeHtml(course.title)}</h3><div class="course-progress-label"><span>Course progress</span><strong>${course.progress}%</strong></div><div class="progress-track"><span style="width:${course.progress}%"></span></div><button class="continue-button" data-course="${escapeHtml(course.title)}" data-course-code="${escapeHtml(course.code)}">${course.progress ? 'Continue learning' : 'Start learning'} <span>→</span></button></div>
    `;
    grid.append(card);
  }
  document.querySelector('.course-section .heading-count').textContent = String(grid.querySelectorAll('.course-card').length).padStart(2, '0');
}

function updateCourseCard(card, course) {
  const progress = Number(course.progress) || 0;
  card.dataset.search = `${course.title} ${course.code} ${course.instructor}`.toLowerCase();
  card.querySelector('.course-progress-label strong').textContent = `${progress}%`;
  card.querySelector('.progress-track span').style.width = `${progress}%`;
  const action = card.querySelector('.continue-button');
  action.dataset.course = course.title;
  action.dataset.courseCode = course.code;
  action.firstChild.textContent = progress ? 'Continue learning ' : 'Start learning ';
}

async function openCourse(courseCode) {
  if (!currentUser || currentUser.role !== 'student') return;
  try {
    const response = await fetch(`/api/courses/${encodeURIComponent(courseCode)}`);
    const course = await response.json();
    if (!response.ok) throw new Error(course.error || 'Course could not be opened');
    course.materials = Array.isArray(course.materials) ? course.materials : [];
    activeCourse = course;
    activeMaterialId = course.materials[0]?.id || null;
    const firstIncomplete = course.lessons.findIndex((lesson) => !lesson.completed);
    activeLessonIndex = firstIncomplete === -1 ? course.lessons.length - 1 : firstIncomplete;
    document.querySelector('#student-dashboard').hidden = true;
    document.querySelector('#profile-page').hidden = true;
    document.querySelector('#course-learning-page').hidden = false;
    document.querySelector('#student-nav').hidden = true;
    document.querySelector('#page-label').textContent = course.code;
    renderCourseLearning();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    document.querySelector('#course-learning-page').hidden = true;
    document.querySelector('#student-dashboard').hidden = false;
    document.querySelector('#student-nav').hidden = false;
    showToast(error.message || 'Course could not be opened');
  }
}

function renderCourseLearning() {
  if (!activeCourse) return;
  const course = activeCourse;
  const percent = course.progress;
  document.querySelector('#learning-course-code').textContent = course.code;
  document.querySelector('#learning-course-title').textContent = course.title;
  document.querySelector('#learning-course-instructor').textContent = `${course.instructor} · ${course.completed_count} of ${course.lessons.length} lessons complete`;
  document.querySelector('#learning-progress-value').textContent = `${percent}%`;
  document.querySelector('#learning-progress-bar').style.width = `${percent}%`;
  document.querySelector('#lesson-list').innerHTML = course.lessons.map((lesson, index) => `
    <button class="lesson-nav-item ${index === activeLessonIndex ? 'active' : ''} ${lesson.completed ? 'completed' : ''}" type="button" data-lesson-index="${index}" aria-current="${index === activeLessonIndex ? 'step' : 'false'}">
      <span class="lesson-number">${lesson.completed ? '✓' : String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(lesson.title)}</span>
    </button>
  `).join('');
  const lesson = course.lessons[activeLessonIndex];
  document.querySelector('#lesson-position').textContent = `LESSON ${activeLessonIndex + 1} OF ${course.lessons.length}`;
  document.querySelector('#lesson-title').textContent = lesson.title;
  document.querySelector('#lesson-description').textContent = lesson.content;
  const materials = Array.isArray(course.materials) ? course.materials : [];
  course.materials = materials;
  document.querySelector('#material-count').textContent = `${materials.length} ${materials.length === 1 ? 'file' : 'files'}`;
  renderMaterialLinks(materials, document.querySelector('#student-material-list'), 'No PDFs shared for this course yet.');
  const selectedMaterial = materials.find((material) => material.id === activeMaterialId) || materials[0];
  const viewer = document.querySelector('#course-pdf-viewer');
  if (selectedMaterial) {
    activeMaterialId = selectedMaterial.id;
    viewer.hidden = false;
    document.querySelector('#course-pdf-name').textContent = selectedMaterial.name;
    document.querySelector('#course-pdf-frame').src = `${selectedMaterial.download_url}?view=1#toolbar=1&navpanes=0`;
    document.querySelector('#course-pdf-download').href = selectedMaterial.download_url;
    document.querySelector('#course-pdf-download').setAttribute('download', selectedMaterial.name);
    renderMaterialLinks(materials, document.querySelector('#student-material-list'), 'No PDFs shared for this course yet.');
  } else {
    viewer.hidden = true;
    document.querySelector('#course-pdf-frame').removeAttribute('src');
  }
  document.querySelector('#lesson-previous').disabled = activeLessonIndex === 0;
  document.querySelector('#lesson-next').disabled = activeLessonIndex === course.lessons.length - 1;
  const completeButton = document.querySelector('#lesson-complete');
  completeButton.disabled = lesson.completed;
  completeButton.innerHTML = lesson.completed ? 'Lesson completed <span>✓</span>' : 'Mark complete <span>✓</span>';
}

async function setLessonCompleted(completed) {
  if (!activeCourse) return;
  const lesson = activeCourse.lessons[activeLessonIndex];
  try {
    const response = await fetch(`/api/courses/${encodeURIComponent(activeCourse.code)}/lessons/${lesson.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Progress could not be saved');
    lesson.completed = result.completed;
    activeCourse.completed_count = result.completed_count;
    activeCourse.progress = result.progress;
    renderCourseLearning();
    const card = courseGrid.querySelector(`[data-course-code="${CSS.escape(activeCourse.code)}"]`);
    if (card) updateCourseCard(card, activeCourse);
  } catch (error) {
    showToast(error.message || 'Progress could not be saved');
  }
}

function showDashboard(user) {
  currentUser = user;
  const isAdmin = user.role === 'lecturer';
  const displayName = user.name || user.email.split('@')[0];
  const initials = displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  appShell.hidden = false;
  authScreen.hidden = true;
  document.querySelector('#student-dashboard').hidden = isAdmin;
  document.querySelector('#admin-dashboard').hidden = !isAdmin;
  document.querySelector('#student-nav').hidden = isAdmin;
  document.querySelector('#admin-nav').hidden = !isAdmin;
  document.querySelector('#page-label').textContent = isAdmin ? 'School workspace' : 'Overview';
  document.querySelector('#signed-in-name').textContent = displayName;
  document.querySelector('#profile-name').textContent = displayName;
  document.querySelector('#profile-role').textContent = isAdmin ? 'Lecturer / school admin' : 'Student';
  document.querySelector('#profile-avatar').textContent = initials;
  document.querySelector('#top-avatar').textContent = initials;
  document.querySelector('#student-name').textContent = displayName.split(/\s+/)[0];
  document.querySelector('#profile-page-avatar').textContent = initials;
  document.querySelector('#profile-page-name').textContent = displayName;
  document.querySelector('#profile-page-fullname').textContent = displayName;
  document.querySelector('#profile-page-email').textContent = user.email;
  document.querySelector('#profile-page-role').textContent = isAdmin ? 'Lecturer / school admin' : 'Student';
  document.querySelector('#profile-page').hidden = true;
  document.querySelector('#course-learning-page').hidden = true;
  document.querySelector('#student-dashboard').hidden = isAdmin;
  document.querySelector('#admin-dashboard').hidden = !isAdmin;
  document.querySelector('#student-nav').hidden = isAdmin;
  document.querySelector('#admin-nav').hidden = !isAdmin;
  document.querySelector('#page-label').textContent = isAdmin ? 'School workspace' : 'Overview';
  if (isAdmin) loadAdminDashboard();
  else loadStudentDashboard();
}

function openProfile() {
  if (!currentUser) return;
  document.querySelector('#student-dashboard').hidden = true;
  document.querySelector('#admin-dashboard').hidden = true;
  document.querySelector('#course-learning-page').hidden = true;
  document.querySelector('#student-nav').hidden = true;
  document.querySelector('#admin-nav').hidden = true;
  document.querySelector('#profile-page').hidden = false;
  document.querySelector('#page-label').textContent = 'Profile';
}

document.querySelectorAll('[data-open-profile]').forEach((button) => {
  button.addEventListener('click', openProfile);
});

document.querySelector('#profile-back').addEventListener('click', () => {
  if (currentUser) showDashboard(currentUser);
});

async function loadStudentDashboard() {
  try {
    const [coursesResponse, assignmentsResponse, classesResponse] = await Promise.all([
      fetch('/api/courses'), fetch('/api/assignments'), fetch('/api/classes'),
    ]);
    if ([coursesResponse, assignmentsResponse, classesResponse].some((response) => response.status === 401)) {
      showAuthScreen();
      return;
    }
    if ([coursesResponse, assignmentsResponse, classesResponse].some((response) => !response.ok)) throw new Error('Student data unavailable');
    const [courses, assignments, classes] = await Promise.all([
      coursesResponse.json(), assignmentsResponse.json(), classesResponse.json(),
    ]);
    renderStudentCourses(courses);
    renderStudentAssignments(assignments);
    renderOnlineClasses(classes, document.querySelector('#student-class-list'));
  } catch {
    showToast('Could not load student dashboard data');
  }
}

function showAuthScreen() {
  currentUser = null;
  appShell.hidden = true;
  authScreen.hidden = false;
}

let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    const selected = tab.dataset.authTab === mode;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.register-only').forEach((element) => { element.hidden = !registering; });
  document.querySelector('#auth-name').required = registering;
  document.querySelector('#auth-password').autocomplete = registering ? 'new-password' : 'current-password';
  document.querySelector('#auth-eyebrow').textContent = registering ? 'START YOUR NEXT CHAPTER' : 'WELCOME BACK';
  document.querySelector('#auth-title').textContent = registering ? 'Find your footing.' : 'Good to see you.';
  document.querySelector('#auth-subtitle').textContent = registering
    ? 'Create an account for your learning space.'
    : 'Sign in to pick up where you left off.';
  document.querySelector('#auth-submit').innerHTML = registering ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  document.querySelector('#auth-error').hidden = true;
}

document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => setAuthMode(tab.dataset.authTab));
});

document.querySelector('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form));
  const endpoint = authMode === 'register' ? '/api/register' : '/api/login';
  const errorMessage = document.querySelector('#auth-error');
  const submitButton = document.querySelector('#auth-submit');
  submitButton.disabled = true;
  errorMessage.hidden = true;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not sign in');
    form.reset();
    showDashboard(result.user);
  } catch (error) {
    errorMessage.textContent = error.message || 'The portal could not be reached.';
    errorMessage.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector('#signout-button').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  showAuthScreen();
  setAuthMode('login');
});

async function restoreSession() {
  try {
    const response = await fetch('/api/me');
    if (response.ok) {
      const result = await response.json();
      showDashboard(result.user);
      return;
    }
  } catch {
    // Keep the sign-in form available if the API is temporarily unreachable.
  }
  showAuthScreen();
}

restoreSession();

async function submitAdminForm(form, endpoint) {
  const values = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save this item');
    form.reset();
    showToast('Saved and shared with students');
    await loadAdminDashboard();
  } catch (error) {
    showToast(error.message || 'Could not save this item');
  }
}

document.querySelector('#course-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submitAdminForm(event.currentTarget, '/api/courses');
});

document.querySelector('#assignment-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submitAdminForm(event.currentTarget, '/api/assignments');
});

searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim().toLowerCase();
  let visibleCount = 0;

  for (const card of document.querySelectorAll('.course-card')) {
    const matches = `${card.dataset.search} ${card.querySelector('h3').textContent}`.toLowerCase().includes(query);
    card.hidden = !matches;
    if (matches) visibleCount += 1;
  }

  emptySearch.hidden = visibleCount > 0;
});

document.querySelector('#show-all').addEventListener('click', (event) => {
  const expanded = courseGrid.classList.toggle('show-all');
  event.currentTarget.innerHTML = expanded ? 'Show fewer <span>↑</span>' : 'View all courses <span>→</span>';
});

document.addEventListener('click', (event) => {
  const toastButton = event.target.closest('[data-toast]');
  if (toastButton) showToast(toastButton.dataset.toast);

  const bookmark = event.target.closest('.bookmark-button');
  if (bookmark) {
    bookmark.classList.toggle('saved');
    bookmark.textContent = bookmark.classList.contains('saved') ? '♥' : '♡';
  }

  const continueButton = event.target.closest('.continue-button');
  if (continueButton) {
    event.preventDefault();
    event.stopPropagation();
    openCourse(continueButton.dataset.courseCode || continueButton.closest('.course-card')?.dataset.courseCode);
    return;
  }

  const courseCard = event.target.closest('.course-card');
  if (courseCard && !event.target.closest('.bookmark-button')) {
    openCourse(courseCard.dataset.courseCode);
    return;
  }

  const viewLink = event.target.closest('[data-view]');
  if (viewLink) {
    const viewName = viewLink.dataset.view;
    const label = document.querySelector('#page-label');
    const navItems = [...document.querySelectorAll('.nav-item')];
    label.textContent = viewName.charAt(0).toUpperCase() + viewName.slice(1);
    navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === viewName));
    if (viewName !== 'home') showToast(`${label.textContent} view selected`);
  }
});

courseGrid.addEventListener('keydown', (event) => {
  const card = event.target.closest('.course-card');
  if (!card || event.target.closest('button')) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openCourse(card.dataset.courseCode);
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.focus();
  }
  if (event.key === 'Escape') searchInput.blur();
});

document.querySelector('.assignment-list').addEventListener('change', async (event) => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  const row = event.target.closest('[data-assignment-id]');
  if (!row) return;

  try {
    const response = await fetch(`/api/assignments/${row.dataset.assignmentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: event.target.checked }),
    });
    if (!response.ok) throw new Error('Progress could not be saved');
    document.querySelector('.footer-status').innerHTML = '<i></i> All progress saved';
    if (!document.querySelector('#admin-dashboard').hidden) loadAdminDashboard();
  } catch {
    event.target.checked = !event.target.checked;
    showToast('Could not save assignment progress. Is the portal server running?');
  }
});

document.querySelector('#class-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submitAdminForm(event.currentTarget, '/api/classes');
});

document.querySelector('#material-course').addEventListener('change', (event) => {
  loadAdminMaterials(event.currentTarget.value);
});

document.querySelector('#material-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const courseCode = form.elements.course_code.value;
  const file = form.elements.file.files[0];
  const feedback = document.querySelector('#material-feedback');
  if (!courseCode || !file) return;
  feedback.hidden = true;
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await fetch(`/api/courses/${encodeURIComponent(courseCode)}/materials`, {
      method: 'POST',
      body: new FormData(form),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Upload failed');
    feedback.textContent = `${result.name} uploaded to ${courseCode}.`;
    feedback.className = 'form-feedback success';
    feedback.hidden = false;
    form.elements.file.value = '';
    await loadAdminMaterials(courseCode);
  } catch (error) {
    feedback.textContent = error.message || 'The PDF could not be uploaded.';
    feedback.className = 'form-feedback error';
    feedback.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector('#course-back').addEventListener('click', () => {
  document.querySelector('#course-learning-page').hidden = true;
  document.querySelector('#student-dashboard').hidden = false;
  document.querySelector('#student-nav').hidden = false;
  document.querySelector('#page-label').textContent = 'Overview';
  window.scrollTo({ top: document.querySelector('#courses').offsetTop, behavior: 'smooth' });
});

document.querySelector('#lesson-list').addEventListener('click', (event) => {
  const lessonButton = event.target.closest('[data-lesson-index]');
  if (!lessonButton) return;
  activeLessonIndex = Number(lessonButton.dataset.lessonIndex);
  renderCourseLearning();
});

document.querySelector('#lesson-previous').addEventListener('click', () => {
  if (activeLessonIndex > 0) activeLessonIndex -= 1;
  renderCourseLearning();
});

document.querySelector('#lesson-next').addEventListener('click', () => {
  if (activeCourse && activeLessonIndex < activeCourse.lessons.length - 1) activeLessonIndex += 1;
  renderCourseLearning();
});

document.querySelector('#lesson-complete').addEventListener('click', () => setLessonCompleted(true));

document.querySelector('#student-material-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-material-id]');
  if (!button || !activeCourse) return;
  activeMaterialId = button.dataset.materialId;
  renderCourseLearning();
});