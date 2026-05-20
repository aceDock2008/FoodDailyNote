const STORAGE_KEY = "meal-diary-v1";
const PHOTO_DB_NAME = "meal-diary-photos";
const PHOTO_STORE_NAME = "photos";
const mealLabels = {
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  snack: "點心"
};

const state = {
  entries: [],
  view: "list",
  photoData: "",
  photoId: "",
  deferredPrompt: null
};

const $ = (selector) => document.querySelector(selector);
const form = $("#mealForm");
const toast = $("#toast");

const fields = {
  id: $("#entryId"),
  date: $("#dateInput"),
  mealType: $("#mealTypeInput"),
  dish: $("#dishInput"),
  cost: $("#costInput"),
  place: $("#placeInput"),
  mood: $("#moodInput"),
  note: $("#noteInput"),
  photo: $("#photoInput"),
  photoPreview: $("#photoPreview"),
  photoPrompt: $("#photoPrompt"),
  photoMeta: $("#photoMeta"),
  search: $("#searchInput"),
  filterDate: $("#filterDateInput"),
  filterMeal: $("#filterMealInput")
};

function todayString() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function money(value) {
  const number = Number(value || 0);
  return number.toLocaleString("zh-Hant-TW");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function loadEntries() {
  try {
    state.entries = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    state.entries = [];
  }
}

function openPhotoDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("此瀏覽器不支援照片資料庫"));
      return;
    }

    const request = indexedDB.open(PHOTO_DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE_NAME)) {
        db.createObjectStore(PHOTO_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function runPhotoStore(mode, callback) {
  return openPhotoDb().then((db) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE_NAME, mode);
      const store = tx.objectStore(PHOTO_STORE_NAME);
      const request = callback(store);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    })
  );
}

function putPhoto(dataUrl, photoId = crypto.randomUUID()) {
  return runPhotoStore("readwrite", (store) => store.put(dataUrl, photoId)).then(() => photoId);
}

function getPhoto(photoId) {
  if (!photoId) return Promise.resolve("");
  return runPhotoStore("readonly", (store) => store.get(photoId)).then((value) => value || "");
}

function deletePhoto(photoId) {
  if (!photoId) return Promise.resolve();
  return runPhotoStore("readwrite", (store) => store.delete(photoId)).catch(() => undefined);
}

async function migrateInlinePhotosToIndexedDb() {
  let changed = false;
  const migrated = [];

  for (const entry of state.entries) {
    if (entry.photo?.startsWith("data:image/")) {
      try {
        const photoId = entry.photoId || crypto.randomUUID();
        await putPhoto(entry.photo, photoId);
        const { photo, ...entryWithoutInlinePhoto } = entry;
        migrated.push({ ...entryWithoutInlinePhoto, photoId });
        changed = true;
      } catch {
        migrated.push(entry);
      }
    } else {
      migrated.push(entry);
    }
  }

  if (changed) {
    state.entries = migrated;
    saveEntries();
  }
}

function isStorageQuotaError(error) {
  return error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function storageUsageKb() {
  return Math.round((JSON.stringify(state.entries).length * 2) / 1024);
}

function saveEntries() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
    return true;
  } catch (error) {
    if (isStorageQuotaError(error)) {
      showToast("儲存空間不足，請先匯出備份或刪除部分照片");
      return false;
    }
    showToast("儲存失敗，請重新整理後再試");
    return false;
  }
}

function compressImageSource(src, maxSize = 900, quality = 0.64) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("照片壓縮失敗"));
    image.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.src = src;
  });
}

async function compactStoredPhotos() {
  const compacted = [];
  for (const entry of state.entries) {
    if (entry.photo?.startsWith("data:image/")) {
      try {
        compacted.push({
          ...entry,
          photo: await compressImageSource(entry.photo)
        });
      } catch {
        compacted.push(entry);
      }
    } else {
      compacted.push(entry);
    }
  }
  state.entries = compacted;
}

async function saveEntriesWithRecovery(previousEntries) {
  if (saveEntries()) return true;

  showToast("儲存空間不足，正在嘗試壓縮照片");
  await compactStoredPhotos();
  if (saveEntries()) {
    showToast(`已壓縮照片並儲存，目前約 ${storageUsageKb()} KB`);
    return true;
  }

  state.entries = previousEntries;
  saveEntries();
  showToast("仍然無法儲存，請先匯出備份或刪除舊照片");
  return false;
}

function resetForm() {
  form.reset();
  fields.id.value = "";
  fields.date.value = todayString();
  state.photoData = "";
  state.photoId = "";
  fields.photo.value = "";
  fields.photoPreview.hidden = true;
  fields.photoPreview.removeAttribute("src");
  fields.photoPrompt.hidden = false;
  fields.photoMeta.textContent = "照片會壓縮後儲存在這台裝置。";
  form.querySelector(".primary-button").textContent = "儲存紀錄";
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("讀取照片失敗"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("照片格式無法使用"));
      image.onload = () => {
        const maxSize = 900;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.68));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function filteredEntries() {
  const keyword = fields.search.value.trim().toLowerCase();
  const date = fields.filterDate.value;
  const meal = fields.filterMeal.value;

  return state.entries
    .filter((entry) => !date || entry.date === date)
    .filter((entry) => !meal || entry.mealType === meal)
    .filter((entry) => {
      if (!keyword) return true;
      return [entry.dish, entry.place, entry.note, entry.mood]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    })
    .sort((a, b) => `${b.date} ${b.createdAt}`.localeCompare(`${a.date} ${a.createdAt}`));
}

function updateSummary() {
  const currentMonth = todayString().slice(0, 7);
  const monthCost = state.entries
    .filter((entry) => entry.date.startsWith(currentMonth))
    .reduce((sum, entry) => sum + Number(entry.cost || 0), 0);

  $("#totalEntries").textContent = state.entries.length;
  $("#monthCost").textContent = money(monthCost);
  $("#photoCount").textContent = state.entries.filter((entry) => entry.photo || entry.photoId).length;
}

function renderList(entries) {
  const list = $("#listView");
  const template = $("#recordTemplate");
  list.innerHTML = "";

  if (!entries.length) {
    list.innerHTML = '<div class="empty-state">目前沒有符合條件的紀錄。</div>';
    return;
  }

  entries.forEach((entry) => {
    const card = template.content.firstElementChild.cloneNode(true);
    const image = card.querySelector("img");
    const photoLabel = card.querySelector(".photo-button span");
    const meta = [
      entry.cost ? `NT$ ${money(entry.cost)}` : "",
      entry.place || "",
      entry.mood || ""
    ].filter(Boolean);

    if (entry.photo || entry.photoId) {
      image.alt = `${entry.dish}照片`;
      if (entry.photo) {
        image.src = entry.photo;
        photoLabel.hidden = true;
      } else {
        photoLabel.textContent = "照片載入中";
        getPhoto(entry.photoId).then((photo) => {
          if (photo) {
            image.src = photo;
            photoLabel.hidden = true;
          } else {
            image.remove();
            photoLabel.textContent = "無照片";
          }
        });
      }
    } else {
      image.remove();
      photoLabel.textContent = "無照片";
    }

    card.querySelector(".meal-pill").textContent = mealLabels[entry.mealType] || entry.mealType;
    card.querySelector("time").textContent = entry.date;
    card.querySelector("h3").textContent = entry.dish;
    card.querySelector(".record-meta").textContent = meta.join(" · ") || "未填寫額外資訊";
    card.querySelector(".record-note").textContent = entry.note || "";
    card.querySelector(".edit-record").addEventListener("click", () => editEntry(entry.id));
    card.querySelector(".delete-record").addEventListener("click", () => deleteEntry(entry.id));
    list.append(card);
  });
}

function renderCalendar(entries) {
  const container = $("#calendarView");
  container.innerHTML = "";
  const baseDate = fields.filterDate.value || todayString();
  const [year, month] = baseDate.split("-").map(Number);
  const totalDays = new Date(year, month, 0).getDate();

  for (let day = 1; day <= totalDays; day += 1) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "calendar-cell";
    cell.innerHTML = `<div class="calendar-day">${day}</div>`;
    entries
      .filter((entry) => entry.date === date)
      .slice(0, 4)
      .forEach((entry) => {
        const item = document.createElement("div");
        item.className = "calendar-entry";
        item.textContent = `${mealLabels[entry.mealType]} ${entry.dish}`;
        cell.append(item);
      });
    cell.addEventListener("click", () => {
      fields.filterDate.value = date;
      state.view = "list";
      setView("list");
      render();
    });
    container.append(cell);
  }
}

function setMap(place) {
  const frame = $("#mapFrame");
  const empty = $("#mapEmpty");
  if (!place) {
    frame.removeAttribute("src");
    empty.hidden = false;
    return;
  }
  frame.src = `https://www.google.com/maps?q=${encodeURIComponent(place)}&output=embed`;
  empty.hidden = true;
}

function renderMap(entries) {
  const placeList = $("#placeList");
  placeList.innerHTML = "";
  const withPlaces = entries.filter((entry) => entry.place);
  setMap(withPlaces[0]?.place || "");

  if (!withPlaces.length) {
    placeList.innerHTML = '<div class="empty-state">尚無地點紀錄。</div>';
    return;
  }

  withPlaces.forEach((entry) => {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<strong>${entry.place}</strong><br><span>${entry.date} · ${entry.dish}</span>`;
    button.addEventListener("click", () => setMap(entry.place));
    placeList.append(button);
  });
}

function render() {
  const entries = filteredEntries();
  updateSummary();
  renderList(entries);
  renderCalendar(entries);
  renderMap(entries);
}

function setView(view) {
  state.view = view;
  $("#listView").hidden = view !== "list";
  $("#calendarView").hidden = view !== "calendar";
  $("#mapView").hidden = view !== "map";
  $("#listTab").classList.toggle("active", view === "list");
  $("#calendarTab").classList.toggle("active", view === "calendar");
  $("#mapTab").classList.toggle("active", view === "map");
  $("#listTab").setAttribute("aria-selected", String(view === "list"));
  $("#calendarTab").setAttribute("aria-selected", String(view === "calendar"));
  $("#mapTab").setAttribute("aria-selected", String(view === "map"));
}

async function editEntry(id) {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;
  fields.id.value = entry.id;
  fields.date.value = entry.date;
  fields.mealType.value = entry.mealType;
  fields.dish.value = entry.dish;
  fields.cost.value = entry.cost || "";
  fields.place.value = entry.place || "";
  fields.mood.value = entry.mood || "";
  fields.note.value = entry.note || "";
  state.photoId = entry.photoId || "";
  state.photoData = entry.photo || (state.photoId ? await getPhoto(state.photoId) : "");
  if (state.photoData) {
    fields.photoPreview.src = state.photoData;
    fields.photoPreview.hidden = false;
    fields.photoPrompt.hidden = true;
    fields.photoMeta.textContent = "正在編輯既有照片，可重新選擇。";
  }
  form.querySelector(".primary-button").textContent = "更新紀錄";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function deleteEntry(id) {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;
  const confirmed = window.confirm(`確定刪除「${entry.dish}」這筆紀錄？`);
  if (!confirmed) return;
  state.entries = state.entries.filter((item) => item.id !== id);
  if (saveEntries()) {
    deletePhoto(entry.photoId);
    render();
    showToast("紀錄已刪除");
  }
}

async function saveEntry(event) {
  event.preventDefault();
  const now = new Date().toISOString();
  const id = fields.id.value || crypto.randomUUID();
  const existing = state.entries.find((entry) => entry.id === id);
  const previousEntries = [...state.entries];
  let photoId = state.photoId || existing?.photoId || "";

  if (state.photoData) {
    try {
      photoId = await putPhoto(state.photoData, photoId || crypto.randomUUID());
    } catch {
      showToast("照片儲存失敗，請先不要關閉頁面並匯出備份");
      return;
    }
  }

  const entry = {
    id,
    date: fields.date.value,
    mealType: fields.mealType.value,
    dish: fields.dish.value.trim(),
    cost: fields.cost.value,
    place: fields.place.value.trim(),
    mood: fields.mood.value,
    note: fields.note.value.trim(),
    photoId,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  if (existing) {
    state.entries = state.entries.map((item) => (item.id === id ? entry : item));
  } else {
    state.entries.push(entry);
  }

  const saved = await saveEntriesWithRecovery(previousEntries);
  if (!saved) return;

  showToast(existing ? "紀錄已更新" : "紀錄已儲存");
  resetForm();
  render();
}

async function handlePhotoChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    fields.photoMeta.textContent = "照片處理中...";
    state.photoData = await resizeImage(file);
    fields.photoPreview.src = state.photoData;
    fields.photoPreview.hidden = false;
    fields.photoPrompt.hidden = true;
    fields.photoMeta.textContent = `${file.name} 已加入`;
  } catch (error) {
    showToast(error.message);
    fields.photoMeta.textContent = "照片處理失敗，請再試一次。";
  }
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    showToast("此瀏覽器不支援定位");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      fields.place.value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      showToast("已填入目前座標");
    },
    () => showToast("無法取得定位權限")
  );
}

async function exportData() {
  const entries = await Promise.all(
    state.entries.map(async (entry) => ({
      ...entry,
      photo: entry.photo || (entry.photoId ? await getPhoto(entry.photoId) : "")
    }))
  );
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "食光日記",
    entries
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `meal-diary-${todayString()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      const incoming = Array.isArray(data) ? data : data.entries;
      if (!Array.isArray(incoming)) throw new Error("格式不正確");
      state.entries = [];
      for (const entry of incoming) {
        if (entry.photo?.startsWith("data:image/")) {
          const photoId = entry.photoId || crypto.randomUUID();
          await putPhoto(entry.photo, photoId);
          const { photo, ...entryWithoutInlinePhoto } = entry;
          state.entries.push({ ...entryWithoutInlinePhoto, photoId });
        } else {
          state.entries.push(entry);
        }
      }
      saveEntries();
      render();
      showToast("資料已匯入");
    } catch {
      showToast("匯入失敗，請確認 JSON 格式");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
  }
}

function initInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    $("#installButton").hidden = false;
  });

  $("#installButton").addEventListener("click", async () => {
    if (!state.deferredPrompt) return;
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    $("#installButton").hidden = true;
  });
}

function bindEvents() {
  form.addEventListener("submit", saveEntry);
  fields.photo.addEventListener("change", handlePhotoChange);
  $("#clearFormButton").addEventListener("click", resetForm);
  $("#locationButton").addEventListener("click", useCurrentLocation);
  $("#exportButton").addEventListener("click", exportData);
  $("#importFile").addEventListener("change", importData);
  [fields.search, fields.filterDate, fields.filterMeal].forEach((field) => {
    field.addEventListener("input", render);
    field.addEventListener("change", render);
  });
  $("#listTab").addEventListener("click", () => setView("list"));
  $("#calendarTab").addEventListener("click", () => setView("calendar"));
  $("#mapTab").addEventListener("click", () => setView("map"));
}

async function boot() {
  fields.date.value = todayString();
  loadEntries();
  await migrateInlinePhotosToIndexedDb();
  bindEvents();
  initInstallPrompt();
  registerServiceWorker();
  render();
}

boot();
