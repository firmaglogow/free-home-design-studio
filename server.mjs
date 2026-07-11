import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { ZipArchive } from "archiver";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 5173);
const economyTextModel = process.env.OPENAI_TEXT_MODEL ?? "gpt-5.4-nano";
const imageModel = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
const promptModel = process.env.OPENAI_PROMPT_MODEL ?? economyTextModel;
const analysisModel = process.env.OPENAI_ANALYSIS_MODEL ?? economyTextModel;
const listingModel = process.env.OPENAI_LISTING_MODEL ?? economyTextModel;
const outputDir = path.join(__dirname, ".generated");
const listingMemoryPath = path.join(outputDir, "listing-memory.json");
const managedUsersPath = path.join(outputDir, "app-users.json");
const outputSizes = {
  "1k": { id: "1k", width: 1536, height: 1024, longEdge: 1536 },
  "2k": { id: "2k", width: 2400, height: 1600, longEdge: 2400 },
  "4k": { id: "4k", width: 3840, height: 2560, longEdge: 3840 },
};
const defaultOutputSize = outputSizes["4k"];
const openAIEditMaxEdge = 2560;
const openAIEditMaxPixels = 4_500_000;
const framingModes = {
  original: { label: "jak oryginał", aspectRatio: undefined },
  "landscape-3-2": { label: "poziomy 3:2", aspectRatio: 3 / 2 },
  "landscape-4-3": { label: "poziomy 4:3", aspectRatio: 4 / 3 },
  "landscape-16-9": { label: "poziomy 16:9", aspectRatio: 16 / 9 },
  "square-1-1": { label: "kwadrat 1:1", aspectRatio: 1 },
  "portrait-4-5": { label: "pionowy 4:5", aspectRatio: 4 / 5 },
  "story-9-16": { label: "pionowy 9:16", aspectRatio: 9 / 16 },
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

const APP_KEY = String(process.env.APP_KEY ?? "").trim();
const APP_PASS = String(process.env.APP_PASS ?? "").trim();
const APP_USER = String(process.env.APP_USER ?? "freehome").trim();
const APP_ADMINS = String(process.env.APP_ADMINS ?? "").trim();
const URL_SECRET = APP_KEY || APP_PASS;
const AUTH_USERS = parseAuthUsers();
let managedAuthUsers = readManagedAuthUsersSync();
const AUTH_ON = Boolean(AUTH_USERS.length || managedAuthUsers.length || APP_KEY);
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS ?? "'self' https://crm.freehome.pl";
const AUTH_COOKIE = "foto_auth";
const LEGACY_AUTH_TOKEN = APP_PASS ? createHash("sha256").update(`foto-auth|${APP_KEY}|${APP_PASS}`).digest("hex") : "";
const URL_AUTH_USER = getAuthUsers()[0] ?? (APP_KEY ? { username: "crm", password: APP_KEY, source: "url" } : undefined);
const URL_AUTH_TOKEN = URL_AUTH_USER ? createAuthToken(URL_AUTH_USER) : "";

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function parseAuthUsers() {
  const users = [];
  const seen = new Set();

  function addUser(username, password) {
    const normalizedUsername = normalizeUsername(username || APP_USER || "freehome");
    const normalizedPassword = String(password || "").trim();

    if (!normalizedUsername || !normalizedPassword || seen.has(normalizedUsername)) {
      return;
    }

    seen.add(normalizedUsername);
    users.push({ username: normalizedUsername, password: normalizedPassword, source: "env" });
  }

  const rawUsers = String(process.env.APP_USERS ?? "").trim();

  if (rawUsers) {
    try {
      const parsed = JSON.parse(rawUsers);

      if (Array.isArray(parsed)) {
        parsed.forEach((item) => {
          if (typeof item === "string") {
            const separatorIndex = item.indexOf(":") > -1 ? item.indexOf(":") : item.indexOf("=");
            addUser(item.slice(0, separatorIndex), item.slice(separatorIndex + 1));
            return;
          }

          if (item && typeof item === "object") {
            addUser(item.login ?? item.username ?? item.user, item.password ?? item.pass);
          }
        });
      } else if (parsed && typeof parsed === "object") {
        Object.entries(parsed).forEach(([username, password]) => addUser(username, password));
      }
    } catch {
      rawUsers
        .split(/[\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => {
          const separatorIndex = item.indexOf(":") > -1 ? item.indexOf(":") : item.indexOf("=");

          if (separatorIndex > 0) {
            addUser(item.slice(0, separatorIndex), item.slice(separatorIndex + 1));
          }
        });
    }
  }

  if (APP_PASS) {
    addUser(APP_USER || "freehome", APP_PASS);
  }

  return users;
}

function createAuthToken(user) {
  return createHash("sha256")
    .update(`foto-auth|${APP_KEY}|${user.username}|${getUserCredentialFingerprint(user)}`)
    .digest("hex");
}

function getUserCredentialFingerprint(user) {
  return String(user.passwordHash || user.password || "");
}

function getAdminUsernames() {
  const usernames = new Set(["freehome", "grzegorz", "crm", normalizeUsername(APP_USER)].filter(Boolean));

  APP_ADMINS.split(/[\n,;]+/)
    .map(normalizeUsername)
    .filter(Boolean)
    .forEach((username) => usernames.add(username));

  return usernames;
}

function getUserRole(user) {
  const explicitRole = String(user.role || "").toLowerCase();

  if (explicitRole === "admin" || getAdminUsernames().has(user.username)) {
    return "admin";
  }

  return "agent";
}

function getAuthUsers() {
  const usersByName = new Map();

  for (const user of AUTH_USERS) {
    usersByName.set(user.username, { ...user, role: getUserRole(user) });
  }

  for (const user of managedAuthUsers) {
    usersByName.set(user.username, { ...user, role: getUserRole(user), source: "managed" });
  }

  return [...usersByName.values()];
}

function isAdminUsername(username) {
  const normalizedUsername = normalizeUsername(username);
  const user = getAuthUsers().find((item) => item.username === normalizedUsername);

  return Boolean(user && getUserRole(user) === "admin");
}

function hashManagedPassword(password, salt = randomUUID()) {
  const passwordHash = createHash("sha256")
    .update(`photo-crm-user-password|${salt}|${String(password)}`)
    .digest("hex");

  return { salt, passwordHash };
}

function verifyManagedPassword(user, password) {
  const { passwordHash } = hashManagedPassword(password, user.salt);

  return safeEqual(passwordHash, user.passwordHash);
}

function readManagedAuthUsersSync() {
  if (!existsSync(managedUsersPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(managedUsersPath, "utf8"));
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.users) ? parsed.users : [];

    return items
      .map((item) => ({
        username: normalizeUsername(item?.username ?? item?.login ?? item?.user),
        passwordHash: String(item?.passwordHash || ""),
        salt: String(item?.salt || ""),
        role: String(item?.role || "agent").toLowerCase() === "admin" ? "admin" : "agent",
        createdAt: String(item?.createdAt || ""),
        updatedAt: String(item?.updatedAt || ""),
        source: "managed",
      }))
      .filter((item) => item.username && item.passwordHash && item.salt);
  } catch {
    return [];
  }
}

async function writeManagedAuthUsers(users) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    managedUsersPath,
    JSON.stringify(
      users.map((user) => ({
        username: user.username,
        passwordHash: user.passwordHash,
        salt: user.salt,
        role: getUserRole(user),
        createdAt: user.createdAt || "",
        updatedAt: user.updatedAt || "",
      })),
      null,
      2,
    ),
    "utf8",
  );
}

function publicAuthUser(user) {
  return {
    username: String(user.username || ""),
    role: getUserRole(user),
    source: String(user.source || "env"),
    updatedAt: String(user.updatedAt || ""),
  };
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));
  return first.length === second.length && timingSafeEqual(first, second);
}

function readCookies(header) {
  const cookies = {};

  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");

    if (index > -1) {
      cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
  }

  return cookies;
}

function setAuthCookie(request, response, token) {
  const proto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const secure = proto === "https";
  response.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${token}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
}

function getAuthenticatedUser(cookieValue) {
  const value = String(cookieValue || "");

  if (!value) {
    return undefined;
  }

  for (const user of getAuthUsers()) {
    if (safeEqual(value, createAuthToken(user))) {
      return user;
    }
  }

  if (LEGACY_AUTH_TOKEN && safeEqual(value, LEGACY_AUTH_TOKEN)) {
    const username = normalizeUsername(APP_USER || "freehome");
    return getAuthUsers().find((user) => user.username === username) ?? { username, source: "legacy" };
  }

  return undefined;
}

function findAuthUser(login, password) {
  const normalizedLogin = normalizeUsername(login);
  const candidates = normalizedLogin
    ? getAuthUsers().filter((user) => user.username === normalizedLogin)
    : getAuthUsers();

  return candidates.find((user) => {
    if (user.passwordHash) {
      return verifyManagedPassword(user, password);
    }

    return safeEqual(password, user.password);
  });
}

function loginPage(hasError) {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>FREE HOME - logowanie</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(160deg,#071a0e,#0a2113);color:#f5f1e8;padding:20px}
.card{background:#0d2618;border:1px solid rgba(197,164,78,.25);border-radius:16px;padding:28px;width:min(360px,92vw);box-shadow:0 12px 34px rgba(0,0,0,.45);text-align:center}
h1{font-size:21px;margin:0 0 4px;letter-spacing:.3px}h1 b{color:#d4b86a}p{color:#bfc7bd;font-size:13px;margin:0 0 18px}
input{width:100%;padding:12px;border-radius:10px;border:1px solid #1a4a2e;background:#071a0e;color:#f5f1e8;font-size:15px}
input:focus{outline:none;border-color:#c5a44e}button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:999px;background:#c5a44e;color:#071a0e;font-weight:800;font-size:15px;cursor:pointer}
button:hover{background:#d4b86a}.err{margin:0 0 14px;padding:9px 11px;border-radius:9px;background:rgba(192,57,43,.18);border:1px solid rgba(231,76,60,.5);font-size:13px}
</style></head><body>
<form class="card" method="post" action="/login" autocomplete="off">
<h1>FREE <b>HOME</b></h1>
<p>Narzedzia AI - strefa wewnetrzna</p>
${hasError ? '<div class="err">Bledny login lub haslo. Sprobuj ponownie.</div>' : ""}
<input type="text" name="login" placeholder="Login" autocomplete="username">
<input type="password" name="haslo" placeholder="Haslo" autofocus autocomplete="current-password" required>
<button type="submit">Wejdz</button>
</form>
</body></html>`;
}

app.use((request, response, next) => {
  response.setHeader("Content-Security-Policy", `frame-ancestors ${FRAME_ANCESTORS}`);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Referrer-Policy", "no-referrer");

  if (!AUTH_ON) {
    request.currentUser = APP_USER || "freehome";
    request.currentUserRole = "admin";
    next();
    return;
  }

  const cookies = readCookies(request.headers.cookie);
  const authenticatedUser = getAuthenticatedUser(cookies[AUTH_COOKIE]);

  if (authenticatedUser) {
    request.currentUser = authenticatedUser.username;
    request.currentUserRole = getUserRole(authenticatedUser);
    next();
    return;
  }

  let urlKey = "";

  try {
    urlKey = new URL(request.url, "http://x").searchParams.get("key") || "";
  } catch {
    urlKey = "";
  }

  if (URL_SECRET && urlKey && safeEqual(urlKey, URL_SECRET) && URL_AUTH_TOKEN) {
    request.currentUser = URL_AUTH_USER.username;
    request.currentUserRole = getUserRole(URL_AUTH_USER);
    setAuthCookie(request, response, URL_AUTH_TOKEN);
    next();
    return;
  }

  if (request.method === "POST" && request.path === "/login") {
    const login = String((request.body && request.body.login) || "");
    const password = String((request.body && request.body.haslo) || "");
    const user = findAuthUser(login, password);

    if (user) {
      setAuthCookie(request, response, createAuthToken(user));
      response.statusCode = 302;
      response.setHeader("Location", "/");
      response.end();
      return;
    }

    response.status(401).type("text/html; charset=utf-8").send(loginPage(true));
    return;
  }

  if (request.path.startsWith("/api/")) {
    response.status(401).json({ error: "Wymagane logowanie." });
    return;
  }

  response.status(401).type("text/html; charset=utf-8").send(loginPage(false));
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

async function readListingMemory() {
  if (!existsSync(listingMemoryPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(await readFile(listingMemoryPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeListingMemory(items) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(listingMemoryPath, JSON.stringify(items, null, 2), "utf8");
}

function publicListingMemoryItem(item) {
  return {
    id: String(item.id || ""),
    address: String(item.address || ""),
    content: String(item.content || ""),
    rawData: String(item.rawData || ""),
    createdAt: String(item.createdAt || ""),
    updatedAt: String(item.updatedAt || ""),
    user: String(item.user || ""),
  };
}

app.get("/api/auth/me", (request, response) => {
  const username = request.currentUser || "";
  const role = request.currentUserRole || (isAdminUsername(username) ? "admin" : "agent");
  response.json({
    user: username,
    role,
    isAdmin: role === "admin" || isAdminUsername(username),
  });
});

function requireAdmin(request, response, next) {
  if (request.currentUserRole !== "admin" && !isAdminUsername(request.currentUser)) {
    response.status(403).json({ error: "Tylko administrator może zarządzać profilami agentów." });
    return;
  }

  next();
}

app.get("/api/admin/users", requireAdmin, (request, response) => {
  response.json({
    currentUser: publicAuthUser({ username: request.currentUser, role: request.currentUserRole || "agent" }),
    users: getAuthUsers().map(publicAuthUser).sort((first, second) => first.username.localeCompare(second.username)),
  });
});

app.post("/api/admin/users", requireAdmin, async (request, response) => {
  try {
    const username = normalizeUsername(request.body?.username);
    const password = String(request.body?.password ?? "").trim();
    const role = String(request.body?.role ?? "agent").toLowerCase() === "admin" ? "admin" : "agent";

    if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
      response.status(400).json({ error: "Login może mieć 2-32 znaki: litery, cyfry, kropka, myślnik lub podkreślenie." });
      return;
    }

    if (password.length < 6) {
      response.status(400).json({ error: "Hasło musi mieć minimum 6 znaków." });
      return;
    }

    const now = new Date().toISOString();
    const managedUsers = readManagedAuthUsersSync();
    const existingIndex = managedUsers.findIndex((user) => user.username === username);
    const existingUser = existingIndex > -1 ? managedUsers[existingIndex] : undefined;
    const { salt, passwordHash } = hashManagedPassword(password);
    const nextUser = {
      username,
      passwordHash,
      salt,
      role,
      createdAt: existingUser?.createdAt || now,
      updatedAt: now,
      source: "managed",
    };
    const nextUsers =
      existingIndex > -1
        ? managedUsers.map((user, index) => (index === existingIndex ? nextUser : user))
        : [...managedUsers, nextUser];

    await writeManagedAuthUsers(nextUsers);
    managedAuthUsers = nextUsers;

    response.json({
      user: publicAuthUser(nextUser),
      users: getAuthUsers().map(publicAuthUser).sort((first, second) => first.username.localeCompare(second.username)),
    });
  } catch (error) {
    response.status(500).json({ error: "Nie udało się zapisać profilu agenta." });
  }
});

app.get("/api/listing-memory", async (request, response) => {
  try {
    const items = (await readListingMemory())
      .map(publicListingMemoryItem)
      .filter((item) => item.id && item.address && item.content)
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
      .slice(0, 100);

    response.json({ items });
  } catch (error) {
    response.status(500).json({ error: "Nie udało się odczytać pamięci opisów." });
  }
});

app.post("/api/listing-memory", async (request, response) => {
  try {
    const address = String(request.body?.address ?? "").trim();
    const content = String(request.body?.content ?? "").trim();
    const rawData = String(request.body?.rawData ?? "").trim();

    if (!address) {
      response.status(400).json({ error: "Wpisz adres lub nazwę oferty." });
      return;
    }

    if (!content) {
      response.status(400).json({ error: "Najpierw wygeneruj opis." });
      return;
    }

    if (content.length > 160_000) {
      response.status(400).json({ error: "Opis jest za długi do zapisania." });
      return;
    }

    const now = new Date().toISOString();
    const items = await readListingMemory();
    const normalizedAddress = address.toLowerCase();
    const existingIndex = items.findIndex((item) => String(item.address || "").trim().toLowerCase() === normalizedAddress);
    const nextItem = {
      id: existingIndex > -1 ? items[existingIndex].id || randomUUID() : randomUUID(),
      address,
      content,
      rawData,
      createdAt: existingIndex > -1 ? items[existingIndex].createdAt || now : now,
      updatedAt: now,
      user: request.currentUser || "unknown",
    };

    const nextItems =
      existingIndex > -1
        ? items.map((item, index) => (index === existingIndex ? nextItem : item))
        : [nextItem, ...items];

    await writeListingMemory(nextItems.slice(0, 200));
    response.json({ item: publicListingMemoryItem(nextItem) });
  } catch (error) {
    response.status(500).json({ error: "Nie udało się zapisać opisu w pamięci." });
  }
});

app.post("/api/photo-analysis", upload.single("image"), async (request, response) => {
  try {
    const apiKey = getOpenAIKey();

    if (!apiKey) {
      response.status(503).json({
        error:
          "Na stronie online nie ma ustawionego OPENAI_API_KEY. Dodaj klucz w ustawieniach hostingu jako zmienną środowiskową i uruchom/deployuj aplikację ponownie.",
      });
      return;
    }

    if (!request.file) {
      response.status(400).json({
        error: "Nie przesłano zdjęcia.",
      });
      return;
    }

    const rules = String(request.body.rules ?? "").trim();
    const imageDataUrl = `data:${request.file.mimetype || "image/jpeg"};base64,${request.file.buffer.toString("base64")}`;

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: analysisModel,
        max_output_tokens: 700,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildAnalysisInstruction(rules),
              },
              {
                type: "input_image",
                image_url: imageDataUrl,
                detail: "high",
              },
            ],
          },
        ],
      }),
    });

    const payload = await openaiResponse.json();

    if (!openaiResponse.ok) {
      response.status(openaiResponse.status).json({
        error: extractOpenAIError(payload),
      });
      return;
    }

    const analysis = extractResponseText(payload);

    if (!analysis) {
      response.status(502).json({
        error: "OpenAI nie zwróciło opisu zdjęcia.",
      });
      return;
    }

    response.json({ analysis });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Nie udało się odczytać zdjęcia.",
    });
  }
});

app.post("/api/photo-prompt", upload.single("image"), async (request, response) => {
  try {
    const apiKey = getOpenAIKey();

    if (!apiKey) {
      response.status(503).json({
        error:
          "Na stronie online nie ma ustawionego OPENAI_API_KEY. Dodaj klucz w ustawieniach hostingu jako zmienną środowiskową i uruchom/deployuj aplikację ponownie.",
      });
      return;
    }

    if (!request.file) {
      response.status(400).json({
        error: "Nie przesłano zdjęcia.",
      });
      return;
    }

    const imageDataUrl = `data:${request.file.mimetype || "image/jpeg"};base64,${request.file.buffer.toString("base64")}`;

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: promptModel,
        max_output_tokens: 2200,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildPromptGeneratorInstruction({
                  rules: String(request.body.rules ?? "").trim(),
                  userRequest: String(request.body.userRequest ?? "").trim(),
                  outputResolution: String(request.body.outputResolution ?? "4k").trim(),
                  framingMode: String(request.body.framingMode ?? "original").trim(),
                  presetIds: String(request.body.presetIds ?? "").trim(),
                  fileName: request.file.originalname || "property-photo.jpg",
                }),
              },
              {
                type: "input_image",
                image_url: imageDataUrl,
                detail: "high",
              },
            ],
          },
        ],
      }),
    });

    const payload = await openaiResponse.json();

    if (!openaiResponse.ok) {
      response.status(openaiResponse.status).json({
        error: extractOpenAIError(payload),
      });
      return;
    }

    const text = extractResponseText(payload);
    const result = splitPromptResponse(text);

    if (!result.prompt) {
      response.status(502).json({
        error: "OpenAI nie zwróciło promptu.",
      });
      return;
    }

    response.json(result);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Nie udało się stworzyć promptu.",
    });
  }
});

app.post("/api/photo-compare", upload.single("original"), async (request, response) => {
  try {
    const apiKey = getOpenAIKey();
    const outputName = getSafeJpegFileName(request.body?.outputName);

    if (!apiKey) {
      response.status(503).json({ error: "Brakuje klucza OpenAI do kontroli zgodności." });
      return;
    }

    if (!request.file || !outputName || !existsSync(getGeneratedFilePath(outputName))) {
      response.status(400).json({ error: "Brakuje oryginału albo wygenerowanego zdjęcia do porównania." });
      return;
    }

    const original = await normalizeOpenAIEditInput(request.file.buffer);
    const edited = await readFile(getGeneratedFilePath(outputName));
    const originalUrl = `data:image/jpeg;base64,${original.toString("base64")}`;
    const editedUrl = `data:image/jpeg;base64,${edited.toString("base64")}`;
    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: analysisModel,
        max_output_tokens: 650,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "Compare two real-estate photographs. Image 1 is the original source of truth. Image 2 is an edited result.",
                  "Ignore intended changes to exposure, white balance, sharpness, noise, cleaning of temporary clutter and the explicitly selected canvas ratio.",
                  "Detect only unintended property changes: windows, doors, walls, room geometry, furniture identity/position/size, appliances, lamps, countertops, tiles, grout, flooring, built-ins or camera viewpoint.",
                  "Return JSON only with this exact shape:",
                  '{"risk":"low|medium|high","score":0,"summary":"short Polish summary","warnings":["Polish warning"]}',
                  "score means fidelity to the original property: 100 is fully faithful. Do not invent differences that cannot be seen confidently.",
                ].join("\n"),
              },
              { type: "input_image", image_url: originalUrl, detail: "high" },
              { type: "input_image", image_url: editedUrl, detail: "high" },
            ],
          },
        ],
      }),
    });
    const payload = await openaiResponse.json();

    if (!openaiResponse.ok) {
      response.status(openaiResponse.status).json({ error: extractOpenAIError(payload) });
      return;
    }

    const raw = extractResponseText(payload).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(raw);
    response.json({
      risk: ["low", "medium", "high"].includes(parsed?.risk) ? parsed.risk : "medium",
      score: Math.max(0, Math.min(100, Number(parsed?.score) || 0)),
      summary: String(parsed?.summary || "Kontrola zakończona."),
      warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map(String).slice(0, 8) : [],
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Nie udało się porównać zdjęć.",
    });
  }
});

app.post("/api/listing-copy", upload.array("images", 8), async (request, response) => {
  try {
    const apiKey = getOpenAIKey();

    if (!apiKey) {
      response.status(503).json({
        error:
          "Na stronie online nie ma ustawionego OPENAI_API_KEY. Dodaj klucz w ustawieniach hostingu jako zmienną środowiskową i uruchom/deployuj aplikację ponownie.",
      });
      return;
    }

    const rawData = String(request.body?.rawData ?? "").trim();
    const extraNotes = String(request.body?.extraNotes ?? "").trim();
    const listingTones = String(request.body?.listingTones ?? "").trim();
    const listingDepth = String(request.body?.listingDepth ?? "full").trim();
    const propertyType = String(request.body?.propertyType ?? "apartment").trim();
    const files = Array.isArray(request.files) ? request.files : [];

    if (!rawData && !files.length) {
      response.status(400).json({
        error: "Wpisz dane nieruchomości albo dodaj zdjęcia.",
      });
      return;
    }

    const content = [
      {
        type: "input_text",
        text: buildListingCopyInstruction({
          rawData,
          extraNotes,
          listingTones,
          listingDepth,
          propertyType,
          imageCount: files.length,
        }),
      },
    ];

    for (const file of files) {
      content.push({
        type: "input_image",
        image_url: `data:${file.mimetype || "image/jpeg"};base64,${file.buffer.toString("base64")}`,
        detail: "low",
      });
    }

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: listingModel,
        max_output_tokens: 6800,
        input: [
          {
            role: "user",
            content,
          },
        ],
      }),
    });

    const payload = await openaiResponse.json();

    if (!openaiResponse.ok) {
      response.status(openaiResponse.status).json({
        error: extractOpenAIError(payload),
      });
      return;
    }

    const copy = extractResponseText(payload);

    if (!copy) {
      response.status(502).json({
        error: "OpenAI nie zwróciło opisu ogłoszenia.",
      });
      return;
    }

    response.json({ copy });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Nie udało się stworzyć opisu ogłoszenia.",
    });
  }
});

app.post("/api/photo-edits", upload.single("image"), async (request, response) => {
  try {
    if (!request.file) {
      response.status(400).json({
        error: "Nie przesłano zdjęcia.",
      });
      return;
    }

    const editMode = shouldAllowGenerativeAi(request.body) ? normalizeEditMode(request.body.editMode) : "enhance";
    const framingMode = normalizeFramingMode(request.body.framingMode);
    const outputSize = getOutputSize(request.body.outputResolution);

    if (editMode === "enhance") {
      const output = await makeFaithfulPhotoJpeg(request.file.buffer, outputSize, framingMode);
      const outputFileName = createOutputFileName(
        request.file.originalname,
        outputSize.id,
        request.body.projectName,
        request.body.photoIndex,
      );
      const outputPath = path.join(outputDir, outputFileName);

      await mkdir(outputDir, { recursive: true });
      await writeFile(outputPath, output.buffer);

      response.json({
        image: `/generated/${encodeURIComponent(outputFileName)}`,
        downloadUrl: `/api/download/${encodeURIComponent(outputFileName)}`,
        fileName: outputFileName,
        resolution: outputSize.id,
        width: output.width,
        height: output.height,
        mode: editMode,
        model: "local-sharp",
      });
      return;
    }

    const apiKey = getOpenAIKey();

    if (!apiKey) {
      response.status(503).json({
        error:
          "Na stronie online nie ma ustawionego OPENAI_API_KEY. Dodaj klucz w ustawieniach hostingu jako zmienną środowiskową i uruchom/deployuj aplikację ponownie.",
      });
      return;
    }

    const prompt = buildPortalEditPrompt(String(request.body.prompt ?? "").trim(), framingMode);

    if (!prompt) {
      response.status(400).json({
        error: "Brakuje promptu do obróbki zdjęcia.",
      });
      return;
    }

    const quality = normalizeQuality(request.body.quality);
    const outputFormat = "jpeg";
    const normalizedInputBuffer = await normalizeOpenAIEditInput(request.file.buffer);
    const editInputSize = await getOpenAIEditOutputSize(normalizedInputBuffer, framingMode, outputSize);

    const formData = new FormData();
    const imageBlob = new Blob([normalizedInputBuffer], {
      type: "image/jpeg",
    });

    formData.append("model", imageModel);
    formData.append("prompt", prompt);
    formData.append("image", imageBlob, "property-photo.jpg");
    formData.append("size", editInputSize);
    formData.append("quality", quality);
    formData.append("output_format", outputFormat);
    formData.append("output_compression", "95");

    const openaiResponse = await requestOpenAIImageEdit(apiKey, formData);

    const contentType = openaiResponse.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await openaiResponse.json()
      : await openaiResponse.text();

    if (!openaiResponse.ok) {
      response.status(openaiResponse.status).json({
        error: extractOpenAIError(payload),
      });
      return;
    }

    const editedImageBuffer = await getEditedImageBuffer(payload);

    if (!editedImageBuffer) {
      response.status(502).json({
        error: "OpenAI nie zwróciło obrazu w odpowiedzi.",
      });
      return;
    }

    const output = await makePortalJpeg(editedImageBuffer, outputSize, framingMode);
    const outputFileName = createOutputFileName(
      request.file.originalname,
      outputSize.id,
      request.body.projectName,
      request.body.photoIndex,
    );
    const outputPath = path.join(outputDir, outputFileName);

    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, output.buffer);

    response.json({
      image: `/generated/${encodeURIComponent(outputFileName)}`,
      downloadUrl: `/api/download/${encodeURIComponent(outputFileName)}`,
      fileName: outputFileName,
      resolution: outputSize.id,
      width: output.width,
      height: output.height,
      mode: editMode,
      model: imageModel,
      apiSize: editInputSize,
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Nie udało się połączyć z OpenAI.",
    });
  }
});

app.get("/api/download/:fileName", (request, response) => {
  const fileName = getSafeJpegFileName(request.params.fileName);

  if (!fileName) {
    response.status(400).json({ error: "Nieprawidłowa nazwa pliku." });
    return;
  }

  if (!existsSync(getGeneratedFilePath(fileName))) {
    response.status(404).json({ error: "Plik nie istnieje albo został usunięty." });
    return;
  }

  response.setHeader("Content-Type", "image/jpeg");
  response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  response.sendFile(fileName, { root: outputDir }, (error) => {
    if (error && !response.headersSent) {
      response.status(error.statusCode || 500).json({
        error: error.message || "Nie udało się pobrać pliku.",
      });
    }
  });
});

app.post("/api/save-download/:fileName", async (request, response) => {
  try {
    const fileName = getSafeJpegFileName(request.params.fileName);

    if (!fileName) {
      response.status(400).json({ error: "Nieprawidłowa nazwa pliku." });
      return;
    }

    const sourcePath = getGeneratedFilePath(fileName);

    if (!existsSync(sourcePath)) {
      response.status(404).json({ error: "Plik nie istnieje albo został usunięty." });
      return;
    }

    const downloadsDir = path.join(homedir(), "Downloads");
    await mkdir(downloadsDir, { recursive: true });

    const savedPath = await createUniqueDownloadPath(downloadsDir, fileName);
    await copyFile(sourcePath, savedPath);

    response.json({
      fileName: path.basename(savedPath),
      savedPath,
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Nie udało się zapisać pliku w Pobrane.",
    });
  }
});

app.post("/api/save-downloads", async (request, response) => {
  try {
    const fileNames = Array.isArray(request.body?.fileNames)
      ? request.body.fileNames.map(getSafeJpegFileName).filter(Boolean)
      : [];

    const uniqueFileNames = [...new Set(fileNames)];

    if (!uniqueFileNames.length) {
      response.status(400).json({ error: "Brakuje plików do spakowania." });
      return;
    }

    const missingFile = uniqueFileNames.find((fileName) => !existsSync(getGeneratedFilePath(fileName)));

    if (missingFile) {
      response.status(404).json({ error: `Plik nie istnieje: ${missingFile}` });
      return;
    }

    const downloadsDir = path.join(homedir(), "Downloads");
    await mkdir(downloadsDir, { recursive: true });

    const zipPath = await createUniqueDownloadPath(
      downloadsDir,
      `zdjecia-ai-crm-${new Date().toISOString().slice(0, 10)}.zip`,
    );
    await createZipFile(zipPath, uniqueFileNames);

    response.json({
      fileName: path.basename(zipPath),
      savedPath: zipPath,
      count: uniqueFileNames.length,
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Nie udało się zapisać ZIP w Pobrane.",
    });
  }
});

app.post("/api/export-pack", async (request, response) => {
  try {
    const fileNames = Array.isArray(request.body?.fileNames)
      ? request.body.fileNames.map(getSafeJpegFileName).filter(Boolean)
      : [];
    const packageMode = request.body?.packageMode === "social" ? "social" : "portal";
    const projectSlug = String(request.body?.projectName || "nieruchomosc")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 55) || "nieruchomosc";

    if (!fileNames.length) {
      response.status(400).json({ error: "Brakuje zdjęć do eksportu." });
      return;
    }

    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", `attachment; filename="${projectSlug}-${packageMode}.zip"`);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("error", (error) => response.destroy(error));
    archive.pipe(response);

    for (const [index, fileName] of fileNames.entries()) {
      const sourcePath = getGeneratedFilePath(fileName);
      if (!existsSync(sourcePath)) continue;
      const number = String(index + 1).padStart(2, "0");

      if (packageMode === "social") {
        const square = await sharp(sourcePath).resize(1080, 1080, { fit: "cover", position: "attention" }).jpeg({ quality: 92 }).toBuffer();
        const portrait = await sharp(sourcePath).resize(1080, 1350, { fit: "cover", position: "attention" }).jpeg({ quality: 92 }).toBuffer();
        archive.append(square, { name: `${projectSlug}-${number}-facebook-1x1.jpg` });
        archive.append(portrait, { name: `${projectSlug}-${number}-social-4x5.jpg` });
      } else {
        const portal = await sharp(sourcePath).resize(2400, 1600, { fit: "cover", position: "attention" }).jpeg({ quality: 94 }).toBuffer();
        archive.append(portal, { name: `${projectSlug}-${number}-portal-3x2.jpg` });
      }
    }

    await archive.finalize();
  } catch (error) {
    if (!response.headersSent) {
      response.status(500).json({
        error: error instanceof Error ? error.message : "Nie udało się przygotować paczki ZIP.",
      });
    }
  }
});

app.use((error, _request, response, next) => {
  if (!error) {
    next();
    return;
  }

  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    response.status(413).json({
      error: "Zdjęcie jest za duże. Limit to 20 MB.",
    });
    return;
  }

  response.status(500).json({
    error: error instanceof Error ? error.message : "Błąd serwera.",
  });
});

app.use(
  "/generated",
  express.static(outputDir, {
    fallthrough: false,
    setHeaders(response) {
      response.setHeader("Cache-Control", "private, max-age=86400");
    },
  }),
);
app.use(express.static(path.join(__dirname, "dist")));
app.get(/^\/(?!api).*/, async (_request, response) => {
  response.type("html").send(await readFile(path.join(__dirname, "dist", "index.html"), "utf8"));
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Photo CRM running at http://127.0.0.1:${port}`);
});

function extractOpenAIError(payload) {
  const message =
    typeof payload === "string"
      ? payload
      : payload?.error?.message ?? payload?.message ?? "OpenAI zwróciło błąd.";

  if (/quota|billing|credits|limit/i.test(message)) {
    return "OpenAI API działa, ale konto nie ma dostępnego limitu albo aktywnego billing/środków. Wejdź w Billing na platform.openai.com i dodaj środki lub metodę płatności.";
  }

  if (/invalid image file|image file or mode|unsupported image/i.test(message)) {
    return "OpenAI nie rozpoznało formatu zdjęcia. Program przekonwertował je do standardowego JPG RGB, ale plik nadal jest uszkodzony lub nieobsługiwany. Zapisz zdjęcie ponownie jako JPG albo PNG i spróbuj jeszcze raz.";
  }

  return message || "OpenAI zwróciło błąd.";
}

function normalizeQuality(value) {
  const quality = String(value ?? "high").trim();
  return ["low", "medium", "high"].includes(quality) ? quality : "high";
}

function normalizeEditMode(value) {
  return String(value ?? "ai") === "enhance" ? "enhance" : "ai";
}

function shouldAllowGenerativeAi(body) {
  return String(body?.allowGenerativeAi ?? "").toLowerCase() === "true";
}

function normalizeFramingMode(value) {
  const requestedMode = String(value ?? "original");

  if (requestedMode === "portal") {
    return "landscape-3-2";
  }

  return framingModes[requestedMode] ? requestedMode : "original";
}

function getOutputSize(value) {
  const resolution = String(value ?? defaultOutputSize.id).toLowerCase();
  return outputSizes[resolution] ?? defaultOutputSize;
}

function buildPortalEditPrompt(userPrompt, framingMode) {
  if (!userPrompt) {
    return "";
  }

  const framing = framingModes[framingMode] ?? framingModes.original;
  const framingInstruction = framing.aspectRatio
    ? `- Użytkownik jawnie wybrał format wyniku: ${framing.label}. Wygeneruj dokładnie tę orientację i proporcję. Zmieniaj wyłącznie zewnętrzne płótno kadru tak oszczędnie, jak to możliwe. Nie wolno przesuwać ani skalować obiektów, zmieniać perspektywy, pozycji kamery, geometrii mieszkania lub wymyślać architektury, żeby wypełnić format.`
    : "- Zachowaj oryginalne płótno zdjęcia, orientację, kadr, proporcje i widoczne granice dokładnie 1:1. Wybrana jakość wyjściowa nie jest zgodą na zmianę formatu. Nie zmieniaj wymiarów kadru, nie przycinaj pokoju, nie rozszerzaj sceny, nie dorysowuj boków, nie obracaj, nie rób poziomu z pionu, pionu z poziomu, kwadratu, panoramy ani formatu 3:2. Delikatne wyrównanie techniczne jest dozwolone tylko jak wypoziomowanie aparatu na statywie i nie może zauważalnie zmienić kompozycji ani rozmiaru obiektów.";

  return [
    userPrompt,
    "Wymagania techniczne wyniku:",
    framingInstruction,
    "- To jest wierny retusz zdjęcia, nie redesign wnętrza. Finalny obraz musi pozostać tym samym kadrem, tym samym mieszkaniem i tą samą nieruchomością.",
    "- Zdjęcie wejściowe jest źródłem prawdy. Jeżeli jakiekolwiek polecenie mogłoby zmienić nieruchomość, zignoruj tę część i zachowaj oryginał.",
    "- Nie zmieniaj układu pokoju, architektury, ścian, sufitu, liczby okien, wielkości okien, kształtu okien, położenia okien, drzwi, podłogi, schodów, kuchni, łazienki, zabudowy, szaf, mebli stałych, położenia mebli, rozmiaru mebli, grubości mebli, blatów, kafelków, fug, proporcji pomieszczenia, pozycji kamery, ogniskowej, perspektywy ani kompozycji.",
    "- Układ okien jest nietykalny: zachowaj dokładnie tę samą liczbę, wielkość, kształt, ramy, parapety, położenie i widok przez okna. Nie dodawaj okien, nie usuwaj okien i nie zmieniaj ich rozmiaru.",
    "- Meble są zablokowane w swoich miejscach i wymiarach: nie przesuwaj, nie obracaj, nie zmieniaj rozmiaru, nie zmieniaj grubości, nie wymieniaj i nie usuwaj kanap, łóżek, stołów, krzeseł, szafek, AGD, grzejników, zabudowy ani stałego wyposażenia.",
    "- Kuchnia i łazienka są zablokowane geometrycznie: nie zmieniaj blatów, frontów, uchwytów, kafelków, fug, armatury, AGD, wanny, umywalki, lustra, grzejników ani ich położenia.",
    "- Lampy i punkty świetlne są zablokowane: nie dodawaj, nie usuwaj i nie zmieniaj lamp, żyrandoli, kinkietów, plafonów, lampek nocnych, lamp stojących, listew LED ani punktów świetlnych.",
    "- Efekt ma wyglądać jak profesjonalnie wyretuszowane zdjęcie nieruchomości: naturalne światło, wysoka ostrość, balanced exposure, natural white balance, lens correction, noise reduction i micro contrast.",
    "- Korekta pionów i obiektywu jest dozwolona tylko minimalnie, tak aby zachować ten sam kadr, tę samą pozycję kamery, ten sam rozmiar obiektów i tę samą nieruchomość.",
    "- Jeżeli ściany lub sufit są białe, mogą być idealnie śnieżnobiałe #FFFFFF. Inne kolory ścian, podłóg, mebli, zabudowy i materiałów zachowaj jak w oryginale.",
    "- Usuń rzeczy osobiste, bałagan, kable, papiery, ubrania, kosmetyki, detergenty, naczynia, jedzenie, butelki, kosze, przypadkowe dodatki i niepotrzebne dekoracje. Odsłonięte tło odtwórz wyłącznie z bezpośredniego otoczenia: ten sam wzór kafelków, fug, blatu, podłogi, ściany lub mebla. Zostaw stałe wyposażenie mieszkania. Jeżeli widać łóżko, pościel je równo i hotelowo, ale nie zmieniaj łóżka, rozmiaru łóżka, ramy, zagłówka ani jego położenia.",
    "- Nie dodawaj home stagingu ani nowych przedmiotów, chyba że użytkownik wyraźnie o to poprosił.",
    "- Nie dodawaj lamp, żyrandoli, kinkietów, lampek nocnych, lamp stojących, listew LED, zasłon ani rolet, chyba że użytkownik wyraźnie o to poprosił.",
    "- Zwiększ naturalne światło dzienne tylko przez realistyczną korektę ekspozycji, balansu bieli i istniejące okna. Nie dodawaj sztucznego słońca, nowych lamp, nowych refleksów ani nierealnych cieni.",
    "- Podkręć jakość zdjęcia katalogowo, ale realistycznie. To ma być ultra-fotorealistyczne zdjęcie tej samej nieruchomości, nie remont, nie render, nie CGI.",
    "- Brak HDR, brak CGI, brak renderingu, brak mebli AI, brak fantazyjnego wnętrza, brak fałszywej architektury, brak fałszywego słońca, brak nierealnych cieni, brak wymiany mebli, brak przesuwania mebli, brak zmiany rozmiaru lub grubości mebli, brak zmiany blatów, brak zmiany kafelków, brak zmiany fug, brak zmiany układu okien, brak nowych lamp.",
    "- Nie generuj napisów, ramek, znaków wodnych ani porównania przed/po.",
  ].join("\n\n");
}

async function getEditedImageBuffer(payload) {
  const image = payload?.data?.[0];
  const base64Image = image?.b64_json;
  const imageUrl = image?.url;

  if (base64Image) {
    return Buffer.from(base64Image, "base64");
  }

  if (!imageUrl) {
    return undefined;
  }

  const imageResponse = await fetch(imageUrl);

  if (!imageResponse.ok) {
    throw new Error("OpenAI zwróciło link do obrazu, ale nie udało się go pobrać.");
  }

  return Buffer.from(await imageResponse.arrayBuffer());
}

async function getOpenAIEditOutputSize(imageBuffer, framingMode, outputSize) {
  const metadata = await sharp(imageBuffer, { limitInputPixels: false }).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const selectedAspectRatio = framingModes[framingMode]?.aspectRatio;
  const aspectRatio = selectedAspectRatio ?? Math.min(3, Math.max(1 / 3, width / height));
  const requestedLongEdge = Math.min(outputSize.longEdge, openAIEditMaxEdge);
  let targetWidth;
  let targetHeight;

  if (aspectRatio >= 1) {
    targetWidth = roundImageDimension(requestedLongEdge);
    targetHeight = roundImageDimension(targetWidth / aspectRatio);
  } else {
    targetHeight = roundImageDimension(requestedLongEdge);
    targetWidth = roundImageDimension(targetHeight * aspectRatio);
  }

  const totalPixels = targetWidth * targetHeight;

  if (totalPixels > openAIEditMaxPixels) {
    const scale = Math.sqrt(openAIEditMaxPixels / totalPixels);
    targetWidth = roundImageDimension(targetWidth * scale, "down");
    targetHeight = roundImageDimension(targetHeight * scale, "down");
  }

  return `${targetWidth}x${targetHeight}`;
}

function roundImageDimension(value, direction = "nearest") {
  const rounded = direction === "down" ? Math.floor(value / 16) * 16 : Math.round(value / 16) * 16;
  return Math.max(16, rounded);
}

async function requestOpenAIImageEdit(apiKey, formData) {
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (attempt === 0 && [429, 500, 502, 503, 504].includes(response.status)) {
        await response.arrayBuffer();
        await new Promise((resolve) => setTimeout(resolve, 900));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;

      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Nie udało się połączyć z OpenAI.");
}

async function normalizeOpenAIEditInput(imageBuffer) {
  try {
    return await sharp(imageBuffer, {
      limitInputPixels: false,
      failOn: "none",
    })
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .jpeg({
        quality: 96,
        chromaSubsampling: "4:4:4",
      })
      .toBuffer();
  } catch {
    throw new Error(
      "Nie udało się odczytać formatu zdjęcia. Zapisz je jako standardowy JPG lub PNG i spróbuj ponownie.",
    );
  }
}

async function makeFaithfulPhotoJpeg(imageBuffer, outputSize, framingMode) {
  const pipeline = sharp(imageBuffer, { limitInputPixels: false })
    .rotate()
    .modulate({
      brightness: 1.08,
      saturation: 1.04,
    })
    .linear(1.04, -2)
    .sharpen({
      sigma: 0.8,
      m1: 0.8,
      m2: 1.5,
    });

  return finishJpeg(resizeForFraming(pipeline, outputSize, framingMode));
}

async function makePortalJpeg(imageBuffer, outputSize, framingMode) {
  const pipeline = sharp(imageBuffer, { limitInputPixels: false }).rotate().sharpen({
    sigma: 0.6,
    m1: 0.5,
    m2: 1.1,
  });

  return finishJpeg(resizeForFraming(pipeline, outputSize, framingMode));
}

function resizeForFraming(pipeline, outputSize, framingMode) {
  const aspectRatio = framingModes[framingMode]?.aspectRatio;

  if (aspectRatio) {
    const width = aspectRatio >= 1 ? outputSize.longEdge : Math.round(outputSize.longEdge * aspectRatio);
    const height = aspectRatio >= 1 ? Math.round(outputSize.longEdge / aspectRatio) : outputSize.longEdge;

    return pipeline.resize(width, height, {
      fit: "cover",
      position: "attention",
      withoutEnlargement: false,
    });
  }

  return pipeline.resize(outputSize.longEdge, outputSize.longEdge, {
    fit: "inside",
    withoutEnlargement: false,
  });
}

async function finishJpeg(pipeline) {
  const buffer = await pipeline
    .jpeg({
      quality: 95,
      mozjpeg: true,
      chromaSubsampling: "4:4:4",
    })
    .toBuffer();

  const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();

  return {
    buffer,
    width: metadata.width,
    height: metadata.height,
  };
}

function createOutputFileName(originalName, resolution, projectName, photoIndex) {
  const cleanBaseName = path
    .basename(originalName || "zdjecie")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  const cleanProjectName = String(projectName ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 55);
  const index = String(Math.max(1, Math.min(99, Number(photoIndex) || 1))).padStart(2, "0");
  const prefix = cleanProjectName ? `${cleanProjectName}-${index}` : cleanBaseName || `zdjecie-${index}`;

  return `${prefix}-${resolution}-${randomUUID().slice(0, 8)}.jpg`;
}

function getSafeJpegFileName(fileName) {
  const safeName = path.basename(String(fileName ?? ""));
  return safeName.endsWith(".jpg") ? safeName : "";
}

function getGeneratedFilePath(fileName) {
  return path.join(outputDir, fileName);
}

async function createUniqueDownloadPath(directory, fileName) {
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  let candidatePath = path.join(directory, fileName);
  let counter = 2;

  while (existsSync(candidatePath)) {
    candidatePath = path.join(directory, `${baseName}-${counter}${extension}`);
    counter += 1;
  }

  return candidatePath;
}

function createZipFile(zipPath, fileNames) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);

    for (const fileName of fileNames) {
      archive.file(getGeneratedFilePath(fileName), { name: fileName });
    }

    archive.finalize();
  });
}

function getOpenAIKey() {
  const envPath = path.join(__dirname, ".env");
  let fileKey = "";

  if (existsSync(envPath)) {
    const parsed = dotenv.parse(readFileSync(envPath));
    fileKey = String(parsed.OPENAI_API_KEY ?? "").trim();
  }

  const key = fileKey || String(process.env.OPENAI_API_KEY ?? "").trim();

  if (!key || key === "sk-proj-your-key-here" || key === "wklej_tutaj_swoj_klucz_openai") {
    return "";
  }

  return key;
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") {
    return payload.output_text.trim();
  }

  const parts = [];

  for (const outputItem of payload?.output ?? []) {
    for (const contentItem of outputItem?.content ?? []) {
      if (typeof contentItem?.text === "string") {
        parts.push(contentItem.text);
      }

      if (typeof contentItem?.output_text === "string") {
        parts.push(contentItem.output_text);
      }
    }
  }

  return parts.join("\n").trim();
}

function splitPromptResponse(text) {
  const cleanText = String(text || "")
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!cleanText) {
    return { prompt: "" };
  }

  const promptLabel = String.raw`(?:PROMPT[_ ]?EN|FINAL[_ ]?PROMPT|GOTOWY[_ ]?PROMPT|PROMPT)`;
  const analysisLabel = String.raw`(?:ANALYSIS[_ ]?PL|ANALIZA[_ ]?PL|ANALIZA)`;
  const promptMatch = cleanText.match(
    new RegExp(`(?:^|\\n)\\s*(?:\\*\\*)?${promptLabel}(?:\\*\\*)?\\s*:?\\s*([\\s\\S]*)$`, "i"),
  );
  const analysisMatch = cleanText.match(
    new RegExp(
      `(?:^|\\n)\\s*(?:\\*\\*)?${analysisLabel}(?:\\*\\*)?\\s*:?\\s*([\\s\\S]*?)(?=\\n\\s*(?:\\*\\*)?${promptLabel}(?:\\*\\*)?\\s*:|$)`,
      "i",
    ),
  );
  let prompt = promptMatch?.[1]?.trim() || "";

  if (!prompt && analysisMatch) {
    prompt = cleanText.replace(analysisMatch[0], "").trim();
  }

  if (!prompt) {
    prompt = cleanText;
  }

  return {
    analysis: analysisMatch?.[1]?.trim() || "",
    prompt,
  };
}

function buildPromptGeneratorInstruction({
  rules,
  userRequest,
  outputResolution,
  framingMode,
  presetIds,
  fileName,
}) {
  const normalizedFramingMode = normalizeFramingMode(framingMode);
  const selectedFraming = framingModes[normalizedFramingMode] ?? framingModes.original;
  const portalInstruction = selectedFraming.aspectRatio
    ? `The user explicitly selected the output format ${selectedFraming.label}. The final prompt must require exactly this orientation and aspect ratio. It may adapt only the outer canvas conservatively and must forbid moving or resizing objects, changing perspective, changing the camera viewpoint, inventing architecture or redesigning the property to fill the frame.`
    : "The final prompt must preserve the original canvas, output dimensions, orientation, framing and aspect ratio exactly. It may ask for very slight technical straightening like a tripod-level correction, but not for resizing, cropping, extending the scene, changing portrait/landscape orientation or creating a new composition.";

  return [
    "Jesteś ekspertem od promptów do edycji zdjęć nieruchomości w ChatGPT.",
    "Obejrzyj przesłane zdjęcie i przygotuj gotowy, rozbudowany prompt po angielsku do wklejenia w ChatGPT razem z tym samym zdjęciem.",
    "To NIE jest redesign wnętrza. To ma być instrukcja do profesjonalnego retuszu zdjęcia nieruchomości 1:1.",
    "Finalny prompt ma być uporządkowany i bez powtórzeń. Nie powtarzaj tego samego zakazu w kilku sekcjach.",
    "Użyj dokładnie tej kolejności sekcji: TASK, SOURCE OF TRUTH, USER REQUEST, ALLOWED CHANGES ONLY, LOCKED PROPERTY ELEMENTS, OBSERVED DETAILS TO PRESERVE, PHOTOGRAPHIC FINISH, OUTPUT FORMAT, FINAL VALIDATION.",
    "Najważniejsza konstrukcja promptu: Change only the explicitly requested elements. Keep everything else exactly the same.",
    "",
    "NAJWAŻNIEJSZA ZASADA:",
    "Zdjęcie wejściowe jest jedynym źródłem prawdy. Prompt ma zablokować zmianę mieszkania, geometrii, układu, okien, mebli, lamp, blatów, kafelków, fug, podłogi i proporcji.",
    selectedFraming.aspectRatio
      ? `Użytkownik jawnie wybrał format ${selectedFraming.label}. Ten wybór ma pierwszeństwo przed formatem zdjęcia wejściowego i musi znaleźć się w finalnym promptcie. Nie daje to zgody na zmianę mieszkania, geometrii, perspektywy, pozycji kamery ani położenia i rozmiaru obiektów.`
      : "Prompt ma zablokować zmianę formatu samego zdjęcia: ten sam rozmiar płótna, ta sama orientacja, te same proporcje i ten sam widoczny kadr. Nie wolno robić zdjęcia poziomego z pionowego, pionowego z poziomego, kwadratu, panoramy, formatu 3:2 ani innego przekadrowania.",
    "Dozwolona jest tylko bardzo delikatna korekta techniczna kadru, jak wyrównanie aparatu na statywie. Nie może ona zauważalnie przycinać pokoju, zmieniać rozmiaru obiektów, perspektywy, ogniskowej ani kompozycji.",
    "",
    "W finalnym promptcie po angielsku koniecznie uwzględnij:",
    "- rozpoznany typ pomieszczenia;",
    "- konkretne elementy widoczne na zdjęciu, które trzeba zachować dokładnie w tych samych miejscach;",
    "- dokładny zakaz zmiany układu okien, liczby okien, rozmiaru okien, położenia okien i widoku przez okna;",
    "- dokładny zakaz przesuwania, wymiany, powiększania, pomniejszania, prostowania, pogrubiania lub usuwania mebli i stałego wyposażenia;",
    "- dokładny zakaz zmiany kuchni, łazienki, blatów, frontów, kafelków, fug, armatury, AGD, grzejników i zabudów;",
    "- jeśli widać lodówkę, zamrażarkę, piekarnik, zmywarkę, pralkę albo inne AGD, prompt musi zablokować ich dokładny kształt, szerokość, wysokość, głębokość, fronty, szczeliny drzwi, uchwyty, panele, proporcje i położenie;",
    "- lodówka i AGD mogą wyglądać czysto, ostro i premium, ale nie mogą zostać przerysowane, wymienione, poszerzone, zwężone, przesunięte, uproszczone ani zamienione na inny model;",
    "- drzwi lodówki, szafek, zmywarki, pralki lub piekarnika wolno zamknąć, otworzyć albo przestawić tylko wtedy, gdy użytkownik wyraźnie o to poprosi;",
    "- dokładny zakaz dodawania, usuwania albo zmiany lamp, kinkietów, plafonów, LED-ów, lampek nocnych i punktów świetlnych;",
    "- sprzątanie tylko rzeczy osobistych, bałaganu, kabli, kosmetyków, detergentów, papierów, ubrań, naczyń, jedzenia, butelek i przypadkowych dodatków;",
    "- odtworzenie odsłoniętego tła tylko na podstawie bezpośredniego otoczenia, bez zmiany wzoru materiału;",
    "- jeśli są białe ściany, mogą wyglądać świeżo i śnieżnobiało #FFFFFF; jeśli ściany są inne, zachować ich dokładny kolor;",
    "- jeśli sufit jest biały, ma być śnieżnobiały #FFFFFF, czysty i równomiernie oświetlony;",
    "- jeśli jest łóżko, ma być równo pościelone, ale bez zmiany rozmiaru, ramy, zagłówka i położenia;",
    "- więcej naturalnego światła dziennego wyłącznie przez ekspozycję, balans bieli i istniejące okna;",
    "- minimalną korektę pionów, obiektywu, ekspozycji, ostrości, redukcji szumu i mikro-kontrastu;",
    "- efekt premium real estate catalog / luxury architectural photography, ale ultra-fotorealistyczny i nadal ta sama nieruchomość;",
    "- zakaz HDR, CGI, renderingu, fałszywej architektury, fałszywego słońca, nowych cieni, nowych mebli, nowych lamp i fantazyjnego wnętrza.",
    "",
    "Nie zgaduj elementów, których nie widać. Jeśli coś jest niepewne, w promptcie użyj neutralnej formy typu 'if visible' albo skup się na elementach pewnych.",
    "Nie dodawaj home stagingu, jeśli użytkownik wyraźnie o to nie poprosił. Jeśli poprosił, ogranicz go do kilku małych, naturalnych dodatków bez zmiany układu i bez nowych lamp.",
    "",
    "DANE Z APLIKACJI:",
    `Nazwa pliku: ${fileName}.`,
    `Wybór użytkownika / opis celu: ${userRequest || "brak dodatkowego opisu; wykonaj wierny retusz 1:1 i profesjonalne sprzątanie zdjęcia"}.`,
    `Docelowy rozmiar opisowy: ${outputResolution || "4k"} - traktuj to wyłącznie jako poziom jakości, nie jako zgodę na zmianę proporcji, orientacji, płótna ani kadru.`,
    `Wybrany format wyniku: ${selectedFraming.label}. ${portalInstruction}`,
    `Aktywne tryby aplikacji: ${presetIds || "faithful, clean, catalog"}.`,
    "",
    "STAŁE ZASADY APLIKACJI:",
    rules || "Brak dodatkowych zasad poza twardym zachowaniem 1:1.",
    "",
    "FORMAT ODPOWIEDZI:",
    "Zwróć dokładnie dwie sekcje:",
    "ANALYSIS_PL: krótko po polsku, 4-7 punktów, co rozpoznajesz na zdjęciu i czego trzeba pilnować.",
    "PROMPT_EN: kompletny, konkretny prompt po angielsku do skopiowania do ChatGPT. Ma zawierać dynamiczną listę faktycznie widocznych elementów chronionych, nie powtarzać zakazów, nie zawierać sprzecznych poleceń i być gotowy do użycia bez dodatkowych komentarzy.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildListingCopyInstruction({ rawData, extraNotes, listingTones, listingDepth, propertyType, imageCount }) {
  const propertyTypeLabel =
    {
      apartment: "mieszkanie",
      house: "dom",
      commercial: "lokal",
      plot: "działka",
      other: "inna nieruchomość",
    }[propertyType] || "mieszkanie";

  return [
    "Jesteś dedykowanym asystentem copywritingu nieruchomości dla FREE HOME nieruchomości Głogów.",
    "Twoje zadanie: zamienić surowe dane nieruchomości w gotowe do publikacji ogłoszenie, brzmiące profesjonalnie, konkretnie i sprzedażowo, ale bez sztucznych ozdobników.",
    "",
    "NAJWAŻNIEJSZE ZASADY STYLU",
    "Pisz po polsku.",
    "Pisz konkretnie, pewnie i sprzedażowo.",
    "Buduj opis bardziej rozbudowany niż skrót: portalowy opis ma być pełny, gotowy na Otodom/Gratka/Morizon, z dopracowanymi akapitami i większą liczbą konkretów.",
    "Nie skracaj ważnych informacji do jednego zdania, jeśli da się je naturalnie rozwinąć bez wymyślania faktów.",
    "Każdy akapit ma wnosić konkretną wartość sprzedażową: układ, funkcjonalność, stan, lokalizację, koszty, potencjał, wygodę lub atuty techniczne.",
    "Nie używaj ozdobników typu: z duszą, azyl, marzenie, perełka, magia, wyjątkowy klimat, chyba że użytkownik wkleił takie słowo w danych.",
    "Zachowuj słownictwo użytkownika możliwie wiernie, poprawiając pisownię, składnię, porządek i siłę sprzedażową.",
    "Nie dopisuj faktów, których nie ma w danych lub których nie widać pewnie na zdjęciach.",
    "Jeśli czegoś nie wiadomo, pomiń to zamiast zgadywać.",
    "Nie podawaj numeru telefonu w żadnej sekcji.",
    "",
    "USTAWIENIA Z APLIKACJI",
    `Typ nieruchomości: ${propertyTypeLabel}.`,
    `Aktywne style: ${listingTones || "concrete,sales,premium"}.`,
    `Zakres odpowiedzi: ${listingDepth || "full"}.`,
    "concrete = fakty, porządek, konkrety i brak ozdobników.",
    "sales = mocniejsze argumenty sprzedażowe, lepsze CTA i większa energia.",
    "premium = bardziej elegancki język, ale bez pustych luksusowych fraz.",
    "investment = podkreśl najem, lokatę kapitału, łatwość wynajmu i potencjał inwestycyjny tylko jeśli wynika to z danych.",
    "family = podkreśl wygodę codziennego życia, układ, szkoły, przedszkola i funkcjonalność tylko jeśli wynika to z danych.",
    "standard = zwięźlej, full = pełny materiał domyślny, max = najbardziej rozbudowane warianty bez lania wody.",
    "",
    "DŁUGOŚĆ I GĘSTOŚĆ OPISU",
    "Główny opis portalowy ma być wyraźnie bardziej rozbudowany: zwykle 2200-3600 znaków, jeśli użytkownik podał wystarczająco dużo danych. Dla zakresu max może być dłuższy, ale nadal konkretny.",
    "Jeśli danych jest mało, nie wymyślaj. Rozwiń wtedy tylko pewne informacje i napisz zwięźlej, ale nadal profesjonalnie.",
    "Wstęp po mocnym nagłówku ma być krótki: maksymalnie 2-3 zdania. Nie rozwijaj tam całej oferty; szczegóły przenieś do sekcji Lokalizacja, Rozkład, Stan techniczny i Dodatkowe informacje.",
    "Sekcja Lokalizacja ma mieć 2-4 zdania i opisywać praktyczną wygodę życia: komunikację, sklepy, szkoły, usługi, otoczenie, jeśli wynika to z danych lub jest pewnie podane.",
    "Sekcja Rozkład i powierzchnia ma mieć 3-5 zdań. Rozwiń funkcję każdego ważnego pomieszczenia, balkon, piwnice, układ dwustronny, piętro, windę i ergonomię, jeśli są w danych.",
    "Sekcja Wykończenie i stan techniczny ma mieć 3-5 zdań. Rozwiń stan mieszkania, instalacje, okna, podłogi, zabudowy, AGD, meble pozostające w cenie i gotowość do wejścia, jeśli są w danych.",
    "Sekcja Media i opłaty nie może wyglądać ubogo. Nie zostawiaj pojedynczego zdania typu: Czynsz wynosi 785 zł.",
    "W opisie portalowym, Marketplace, grupach Facebook, social media, SMS i relacji NIE WOLNO pisać zdań organizacyjnych dla agenta typu: warto potwierdzić, należy sprawdzić, do ustalenia, jeśli ma znaczenie dla kupującego, w dokumentach zarządcy, przy prezentacji warto doprecyzować. To są notatki wewnętrzne, nie tekst dla klienta.",
    "Dla mieszkania: jeśli użytkownik podał czynsz, napisz 2-3 konkretne, publiczne zdania. Podaj kwotę jako miesięczny czynsz administracyjny i naturalnie wyjaśnij, że przy mieszkaniu taka opłata zwykle wiąże się z bieżącym utrzymaniem lokalu, administracją i częściami wspólnymi. Jeżeli użytkownik podał składniki czynszu, wymień je konkretnie. Jeżeli ich nie podał, nie wymyślaj składników i nie pisz o potwierdzaniu; zostaw publiczny opis krótki i elegancki, a brak zakresu czynszu przenieś wyłącznie do sekcji Kontrola danych oraz Pytania do właściciela.",
    "Dla domu: nie używaj języka o czynszu administracyjnym, chyba że użytkownik go podał. Skup się na źródle ogrzewania, prądzie, wodzie, kanalizacji/szambie/przydomowej oczyszczalni, gazie, odpadach, podatku od nieruchomości i kosztach utrzymania, tylko jeśli są w danych.",
    "Dla lokalu: rozdziel czynsz/najem od opłat eksploatacyjnych, mediów, VAT, kaucji lub kosztów administracyjnych, tylko jeśli są w danych.",
    "Dla działki: opisz media przy działce lub w drodze, dojazd i ewentualne opłaty/podatki tylko wtedy, gdy wynikają z danych.",
    "Sekcja Dodatkowe informacje ma mieć 2-4 zdania i podsumować potencjał: dla rodziny, pary, singla, na start lub inwestycyjnie, tylko jeśli wynika to z danych.",
    "Unikaj pustych fraz typu komfortowy standard bez wyjaśnienia. Każde mocne słowo podeprzyj faktem z danych.",
    "",
    "STAŁY SCHEMAT OPISU PORTALOWEGO",
    "1. Najpierw nagłówek: mocny, sprzedażowy, wielkimi literami, przyciągający uwagę.",
    "2. Następnie wstęp: krótko podsumuj metraż, typ nieruchomości, stan i potencjał.",
    "3. Sekcja: Lokalizacja.",
    "4. Sekcja: Rozkład i powierzchnia.",
    "5. Sekcja: Wykończenie i stan techniczny.",
    "6. Sekcja: Media i opłaty.",
    "7. Sekcja: Dodatkowe informacje.",
    "8. Stopka: FREE HOME nieruchomości Głogów + krótkie, sprzedażowe podsumowanie z zaproszeniem do kontaktu i obejrzenia nieruchomości.",
    "",
    "FORMAT GŁÓWNEGO OPISU",
    "W głównym opisie portalowym nie używaj list wypunktowanych, kropek-list, myślników-list ani numeracji wewnątrz sekcji.",
    "Używaj składni Markdown do pogrubień: **tekst pogrubiony**.",
    "Pierwszy blok po tytule sekcji Opis na portale musi mieć maksymalnie 2-3 krótkie, mocne zdania pogrubione w całości i napisane WIELKIMI LITERAMI. Nie wolno robić tam 4, 5 ani więcej zdań.",
    "Ten pierwszy blok ma być tylko szybkim otwarciem oferty, nie opisem całego mieszkania. Nie wyliczaj tam wszystkich pomieszczeń, technikaliów i okolicy; rozwiń je dopiero w kolejnych sekcjach.",
    "Po tym pierwszym bloku wróć do normalnej pisowni. Sekcje Lokalizacja, Rozkład i powierzchnia, Wykończenie i stan techniczny, Media i opłaty oraz Dodatkowe informacje pisz normalnie, nie CAPS LOCKIEM.",
    "Każdy nagłówek sekcji w opisie portalowym musi być pogrubiony jako osobna linia, np. **Lokalizacja**.",
    "Bezpośrednio pod pogrubionym nagłówkiem sekcji ma być opis, bez pustej linii przerwy między nagłówkiem a opisem.",
    "Na końcu opisu portalowego pogrub: **FREE HOME nieruchomości Głogów** oraz końcowe podsumowanie z CTA.",
    "Przed linią **FREE HOME nieruchomości Głogów** zostaw jedną pustą linię odstępu od poprzedniego akapitu.",
    "Końcowe CTA po nazwie FREE HOME ma mieć maksymalnie 2-3 zdania. Ma zachęcać do kontaktu, obejrzenia nieruchomości i umówienia prezentacji, ale bez lania wody i bez numeru telefonu.",
    "Nie używaj suchego zakończenia typu tylko: Zapraszam do kontaktu i na prezentację mieszkania. Zrób bardziej zachęcające podsumowanie, np. podkreśl, że warto zobaczyć układ, lokalizację lub potencjał na żywo.",
    "Nagłówki głównych bloków też pogrub: **Opis na portale**, **Sugestie tytułów**, **Skrócona wersja na Marketplace**, **Wersja na grupy Facebook**, **Post social media**, **SMS do klienta**, **Relacja Facebook 24h**, **Bonus YouTube**.",
    "Po nagłówku sekcji pisz czystym tekstem akapitowym, nie listą.",
    "Nie pisz tekstu typu: Oto przygotowana oferta, Ogłoszenie według schematu, Jasne, poniżej.",
    "",
    "KONTROLA DANYCH I PYTANIA",
    "Kontrola danych ma pojawić się zawsze jako osobna sekcja pod materiałami marketingowymi, nie na samej górze.",
    "Kontrola danych ma być bardziej rozwiniętym, praktycznym audytem przed publikacją. Wypisz w krótkich akapitach: co jest gotowe, co jest mocnym atutem, czego brakuje, co warto doprecyzować i jakie informacje są ryzykowne do publikacji bez potwierdzenia.",
    "Nie wymyślaj brakujących informacji. Jeżeli brakuje piętra, ogrzewania, formy własności, piwnicy, balkonu, czynszu, metrażu, stanu prawnego, terminu wydania albo wyposażenia, wskaż to jako brak do uzupełnienia.",
    "Pytania do właściciela mają być ostatnią sekcją całej odpowiedzi, na samym dole.",
    "Pytania mają być gotowe do wysłania właścicielowi lub do zadania na spotkaniu. Maksymalnie 8-12 pytań, tylko jeśli mają sens przy tych danych.",
    "Atuty ze zdjęć dodaj po Bonus YouTube, przed Kontrolą danych.",
    "Jeśli są zdjęcia, wypisz pewne atuty widoczne na zdjęciach i elementy, których można użyć w opisie. Jeśli zdjęć nie ma, napisz krótko: Nie dołączono zdjęć - sekcja do uzupełnienia po analizie fotografii.",
    "",
    "TYTUŁY",
    "Po opisie podaj sekcję: Sugestie tytułów.",
    "Daj 4-6 mocnych propozycji tytułów, każda w osobnej linii.",
    "Tytuły mogą być bardziej agresywne i sprzedażowe, ale nie mogą zawierać numeru telefonu.",
    "Sugestie tytułów pisz normalną pisownią, bez CAPS LOCKA. Nie używaj samych wielkich liter w tytułach, bo portale mogą tego nie lubić.",
    "W tytułach wielką literą zaczynaj tylko zdanie, nazwy własne i skróty, np. Głogów, Piastów Śląskich, m2.",
    "",
    "MARKETPLACE I GRUPY FACEBOOK",
    "Po tytułach podaj sekcję: Skrócona wersja na Marketplace.",
    "Marketplace ma być krótszy niż opis portalowy, ale musi mieć strukturę social media, a nie zbity akapit.",
    "Marketplace pisz w krótkich blokach oddzielonych pustymi liniami: mocny hook, najważniejsze fakty, konkretne atuty, CTA.",
    "Marketplace może używać profesjonalnych emoji, np. 📍 🏡 ✅ 🔑 📩, ale nie przesadzaj. Zwykle 4-7 emoji w całym tekście wystarczy.",
    "Marketplace ma być konkretny, szybki i nastawiony na odzew: zwykle 700-1100 znaków.",
    "W Marketplace NIE WOLNO podawać numeru telefonu.",
    "W Marketplace NIE WOLNO podawać nazwy biura, nazwy FREE HOME ani tekstu typu Biuro FREE HOME nieruchomości Głogów.",
    "W Marketplace nie kończ stopką firmową. Zakończ neutralnym CTA w stylu social, np. Napisz wiadomość i umów prezentację.",
    "Po Marketplace podaj sekcję: Wersja na grupy Facebook.",
    "Wersja na grupy Facebook również bez numeru telefonu, bez nazwy biura i bez FREE HOME.",
    "Wersja na grupy Facebook ma mieć strukturę posta do grup: pierwszy wers z mocnym hookiem i emoji, potem odstęp, 3-5 krótkich bloków z faktami, potem CTA.",
    "Wersja na grupy Facebook może być luźniejsza i bardziej dynamiczna niż portal, ale nadal konkretna, bez przesady, bez krzyku i bez sztucznych obietnic.",
    "Używaj odstępów między blokami. Nie twórz jednej ściany tekstu.",
    "Po wersji Facebook dodaj sekcję: Post social media.",
    "Post social media ma być gotowy do publikacji na profilu biura: 900-1400 znaków, konkretny, z lekką energią, bez numeru telefonu.",
    "Post social media musi mieć dobrą strukturę: mocny pierwszy wers z emoji, odstęp, 2-4 krótkie akapity, odstęp, CTA, odstęp, 3-6 hashtagów.",
    "W social media używaj emoji naturalnie i zawodowo. Tekst ma wyglądać jak dopracowany post na Facebooku, nie jak opis z portalu.",
    "Po poście social dodaj sekcję: SMS do klienta.",
    "SMS do klienta ma mieć 1-2 krótkie wiadomości do właściciela lub kupującego, bez numeru telefonu, naturalne i konkretne.",
    "SMS ma być formalny: używaj Pan/Pani/Państwa. Nie pisz na ty. Nie używaj słów: Ty, Tobie, Twoje, Ciebie.",
    "Po SMS dodaj sekcję: Relacja Facebook 24h.",
    "Relacja Facebook 24h jest do zdjęcia, które użytkownik i tak doda osobno. Przygotuj krótki tekst pasujący na relację ze zdjęciem.",
    "Relacja Facebook 24h ma mieć: krótki napis na zdjęciu, krótki opis relacji i krótkie CTA. Maksymalnie 2-4 krótkie linie. Może mieć 1-3 emoji. Bez hashtagów albo maksymalnie 1 bardzo krótki hashtag.",
    "Nie dodawaj sekcji Scenariusz rolki.",
    "Nie dodawaj sekcji Karta oferty dla właściciela.",
    "",
    "YOUTUBE",
    "Na końcu podaj sekcję: Bonus YouTube.",
    "Podaj tytuł filmu i krótki opis filmu.",
    "Bez numeru telefonu.",
    "",
    "PRZYKŁAD STYLU 1",
    "Dane: kompaktowe mieszkanie dwupokojowe w wieżowcu, nowa winda, 31,1 m2, do wprowadzenia, bez remontu, czynsz 560 zł, ul. Oriona, os. Kopernika, większość mebli zostaje, klatka po remoncie, kuchnia otwarta z salonem, sypialnia z balkonem, idealne na start lub inwestycyjnie.",
    "Styl nagłówka: KOMPAKTOWE MIESZKANIE 31,1 M2 - 2 POKOJE PO REMONCIE, IDEALNE NA START LUB INWESTYCJĘ!",
    "Styl opisu: rzeczowy, z sekcjami, bez list w głównym opisie, z podkreśleniem gotowości do wejścia, lokalizacji, nowej windy i potencjału inwestycyjnego.",
    "",
    "PRZYKŁAD STYLU 2",
    "Dane: mieszkanie 84,30 m2, os. Piastów Śląskich, 2 piętro w bloku 4-piętrowym, 4 pokoje, 3 sypialnie, salon, kuchnia z jadalnią, łazienka i WC osobno, duży korytarz, balkon w płytkach, instalacja miedziana, okna drewniane szczelne, parkiet i płytki, sprzęt AGD, czynsz 1200 zł, odnowione 2 lata temu, dwustronne, 2 piwnice, 3 szafy w zabudowie.",
    "Styl nagłówka: PRZESTRZEŃ I KOMFORT NA OSIEDLU PIASTÓW ŚLĄSKICH! 84,30 M2 - 4 POKOJE, DWUSTRONNY UKŁAD I GOTOWE DO ZAMIESZKANIA!",
    "Styl opisu: rodzinny, konkretny, z naciskiem na układ, metraż, lokalizację, instalacje, dwustronność, piwnice i funkcjonalność.",
    "",
    "ZDJĘCIA",
    imageCount
      ? `Dołączono ${imageCount} zdjęć. Wykorzystaj je pomocniczo do rozpoznania atutów, układu i stanu, ale nie dopisuj elementów, których nie jesteś pewien.`
      : "Nie dołączono zdjęć. Bazuj wyłącznie na danych użytkownika.",
    "",
    "DANE UŻYTKOWNIKA",
    rawData || "Brak danych tekstowych.",
    "",
    "DODATKOWE UWAGI UŻYTKOWNIKA",
    extraNotes || "Brak dodatkowych uwag.",
    "",
    "FORMAT ODPOWIEDZI",
    "Zwróć tylko gotowy materiał do skopiowania, w tej kolejności:",
    "**Opis na portale**",
    "**Sugestie tytułów**",
    "**Skrócona wersja na Marketplace**",
    "**Wersja na grupy Facebook**",
    "**Post social media**",
    "**SMS do klienta**",
    "**Relacja Facebook 24h**",
    "**Bonus YouTube**",
    "**Atuty ze zdjęć**",
    "**Kontrola danych**",
    "**Pytania do właściciela**",
    "Nie dodawaj pustej linii między pogrubionym nagłówkiem podsekcji a opisem pod nim.",
  ].join("\n");
}

function buildAnalysisInstruction(rules) {
  return [
    "Odczytaj zdjęcie nieruchomości dla aplikacji CRM. Odpowiedz po polsku.",
    "Nie projektuj wnętrza i nie wymyślaj zmian. Twoim zadaniem jest precyzyjnie rozpoznać zdjęcie, żeby kolejny krok mógł zbudować prompt jak dla profesjonalnej fotografii nieruchomości.",
    "Nazwij typ pomieszczenia możliwie jednoznacznie, np. łazienka, kuchnia, salon, sypialnia, przedpokój, taras. Jeżeli nie masz pewności, napisz to.",
    "Zwróć krótki opis w sekcjach:",
    "1. Typ pomieszczenia.",
    "2. Co widać: układ, perspektywa, główne stałe elementy, wyposażenie stałe, dokładne położenie mebli, okien i lamp.",
    "3. Zachować dokładnie: architektura, ściany, podłogi, liczba okien, wielkość okien, kształt okien, położenie okien, widok przez okna, drzwi, zabudowa, meble stałe, położenie mebli, rozmiary mebli, grubości mebli, blaty, kafelki, fugi, sprzęty, armatura, grzejniki, lampy, punkty świetlne, układ i proporcje.",
    "4. Kolory i materiały do zachowania: ściany, płytki, fugi, podłogi, blaty, meble, zabudowa, sprzęty, metal, drewno, szkło, tkaniny.",
    "5. Rzeczy możliwe do usunięcia: tylko rzeczy osobiste, bałagan, kosmetyki, detergenty, naczynia, ubrania, papiery, butelki, kable i przypadkowe dodatki.",
    "6. Czyszczenie: konkretne powierzchnie, które powinny wyglądać idealnie czysto, np. wanna, umywalka, lustro, armatura, blat, podłoga, fuga, szkło, sprzęty AGD.",
    "7. Staging: domyślnie nie proponuj dodawania nowych przedmiotów. Jeśli użytkownik wyraźnie poprosi o staging, maksymalnie 3-4 małe elementy, bez nowych lamp, zmian okien, zmian blatów, zmian kafelków ani przesuwania mebli.",
    "8. Ostrożność: napisz, czego nie jesteś pewien, zamiast zgadywać.",
    "Nie wskazuj usuwania mebli, przesuwania mebli, zmiany rozmiaru mebli, zmiany blatów, zmiany kafelków, zmiany fug, dodawania lamp, zmiany okien, dekoracji ani zmiany kolorów, chyba że to są oczywiste rzeczy osobiste lub śmieci.",
    rules ? `Twarde zasady aplikacji:\n${rules}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
