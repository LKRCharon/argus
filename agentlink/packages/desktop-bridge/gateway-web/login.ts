const loginForm = document.getElementById("login") as HTMLFormElement;
const submit = document.getElementById("submit") as HTMLButtonElement;
const notice = document.getElementById("notice")!;
loginForm.onsubmit = async event => {
  event.preventDefault(); submit.disabled = true; notice.textContent = "正在登录…";
  try {
    const response = await fetch("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: (document.getElementById("username") as HTMLInputElement).value, password: (document.getElementById("password") as HTMLInputElement).value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    location.assign(result.next);
  } catch (error) { notice.textContent = error instanceof Error ? error.message : "连接失败，请重试"; submit.disabled = false; }
};
export {};
