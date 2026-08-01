import { api } from "../api.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

export async function renderMemories() {
  const mems = await api.listMemories();
  document.getElementById("memory-list").innerHTML = mems.slice(0, 15).map((m) => `
    <div class="mem">
      <span class="pill">${esc(m.kind)}</span>
      ${m.status !== "approved" ? `<span class="pill">${esc(m.status)}</span>` : ""}
      ${esc(m.text)}
      ${m.status === "awaiting_user" ? `
        <button class="mem-approve" data-id="${m.id}">approve</button>
        <button class="mem-reject" data-id="${m.id}">reject</button>` : ""}
    </div>`).join("");

  for (const btn of document.querySelectorAll(".mem-approve, .mem-reject")) {
    btn.addEventListener("click", async () => {
      await api.decideMemory(btn.dataset.id, btn.classList.contains("mem-approve") ? "approve" : "reject");
      renderMemories();
    });
  }
}
