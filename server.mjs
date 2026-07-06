import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { ZipArchive } from "archiver";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 5173);
const imageModel = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1.5";
const analysisModel = process.env.OPENAI_ANALYSIS_MODEL ?? "gpt-5.5";
const outputDir = path.join(__dirname, ".generated");
const editInputSize = "1536x1024";
const outputSizes = {
  "1k": { id: "1k", width: 1536, height: 1024 },
  "2k": { id: "2k", width: 2400, height: 1600 },
  "4k": { id: "4k", width: 3840, height: 2560 },
};
const defaultOutputSize = outputSizes["4k"];

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- Dostęp CRM-only (aktywne, gdy APP_KEY w env; brak APP_KEY = otwarte/dev) -----
// Wzorzec jak panel wyceny: klucz w URL (?key=) ustawia cookie → działa w iframe CRM,
// bo zdjecia.freehome.pl i crm.freehome.pl to ta sama witryna (cookie same-site).
const APP_KEY = String(process.env.APP_KEY ?? "").trim();
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS ?? "'self' https://crm.freehome.pl";
const AUTH_COOKIE = "foto_auth";
const AUTH_TOKEN = APP_KEY ? createHash("sha256").update("foto-auth|" + APP_KEY).digest("hex") : "";
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function readCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "frame-ancestors " + FRAME_ANCESTORS);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!APP_KEY) return next(); // brak ochrony (lokalnie/dev)
  const cookies = readCookies(req.headers.cookie);
  if (cookies[AUTH_COOKIE] && safeEqual(cookies[AUTH_COOKIE], AUTH_TOKEN)) return next();
  let urlKey = "";
  try { urlKey = new URL(req.url, "http://x").searchParams.get("key") || ""; } catch { /* ignore */ }
  if (urlKey && safeEqual(urlKey, APP_KEY)) {
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const secure = proto === "https";
    res.setHeader(
      "Set-Cookie",
      `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
    );
    return next();
  }
  res.status(403).type("text/plain; charset=utf-8").send("Brak dostepu — narzedzie wewnetrzne CRM.");
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

app.post("/api/photo-analysis", upload.single("image"), async (request, response) => {
  try {
    const apiKey = getOpenAIKey();

    if (!apiKey) {
      response.status(503).json({
        error: "Wpisz prawdziwy OPENAI_API_KEY w pliku .env.",
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

app.post("/api/photo-edits", upload.single("image"), async (request, response) => {
  try {
    const apiKey = getOpenAIKey();

    if (!apiKey) {
      response.status(503).json({
        error: "Wpisz prawdziwy OPENAI_API_KEY w pliku .env.",
      });
      return;
    }

    if (!request.file) {
      response.status(400).json({
        error: "Nie przesłano zdjęcia.",
      });
      return;
    }

    const prompt = buildPortalEditPrompt(String(request.body.prompt ?? "").trim());

    if (!prompt) {
      response.status(400).json({
        error: "Brakuje promptu do obróbki zdjęcia.",
      });
      return;
    }

    const quality = normalizeQuality(request.body.quality);
    const outputSize = getOutputSize(request.body.outputResolution);
    const outputFormat = "jpeg";

    const formData = new FormData();
    const imageBlob = new Blob([request.file.buffer], {
      type: request.file.mimetype || "image/jpeg",
    });

    formData.append("model", imageModel);
    formData.append("prompt", prompt);
    formData.append("image", imageBlob, request.file.originalname || "property-photo.jpg");
    formData.append("size", editInputSize);
    formData.append("quality", quality);
    formData.append("output_format", outputFormat);

    const openaiResponse = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

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

    const outputBuffer = await makePortalJpeg(editedImageBuffer, outputSize);
    const outputFileName = createOutputFileName(request.file.originalname, outputSize.id);
    const outputPath = path.join(outputDir, outputFileName);

    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, outputBuffer);

    response.json({
      image: `/generated/${encodeURIComponent(outputFileName)}`,
      downloadUrl: `/api/download/${encodeURIComponent(outputFileName)}`,
      fileName: outputFileName,
      resolution: outputSize.id,
      width: outputSize.width,
      height: outputSize.height,
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

  return message || "OpenAI zwróciło błąd.";
}

function normalizeQuality(value) {
  const quality = String(value ?? "high").trim();
  return ["low", "medium", "high"].includes(quality) ? quality : "high";
}

function getOutputSize(value) {
  const resolution = String(value ?? defaultOutputSize.id).toLowerCase();
  return outputSizes[resolution] ?? defaultOutputSize;
}

function buildPortalEditPrompt(userPrompt) {
  if (!userPrompt) {
    return "";
  }

  return [
    userPrompt,
    "Wymagania techniczne wyniku:",
    "- Finalny kadr ma być zawsze poziomy, w proporcji 3:2, gotowy na portale nieruchomości.",
    "- To jest profesjonalna obróbka zdjęcia, nie redesign wnętrza. Finalny obraz musi pozostać bez pomyłki tym samym mieszkaniem i tą samą nieruchomością.",
    "- Nie zmieniaj układu pokoju, architektury, ścian, sufitu, okien, drzwi, podłogi, schodów, kuchni, łazienki, zabudowy, szaf, mebli stałych, proporcji pomieszczenia, pozycji kamery, ogniskowej, perspektywy ani kompozycji.",
    "- Efekt ma wyglądać jak luksusowe zdjęcie wnętrza wykonane pełnoklatkową lustrzanką przez profesjonalnego fotografa architektury: naturalne światło, czyste piony, wysoka ostrość, balanced exposure, natural white balance, lens correction, noise reduction i micro contrast.",
    "- Korekta pionów i obiektywu jest dozwolona tylko tak, aby zachować ten sam kadr, tę samą pozycję kamery i tę samą nieruchomość.",
    "- Jeżeli ściany lub sufit są białe, mogą być idealnie śnieżnobiałe #FFFFFF. Inne kolory ścian, podłóg, mebli, zabudowy i materiałów zachowaj jak w oryginale.",
    "- Usuń rzeczy osobiste, bałagan, kable, papiery, ubrania, kosmetyki, detergenty, naczynia, jedzenie, butelki, kosze, przypadkowe dodatki i niepotrzebne dekoracje. Zostaw stałe wyposażenie mieszkania.",
    "- Subtelny home staging jest dozwolony tylko minimalnie i naturalnie: poduszki, pled, książka, świeca, wazon, taca, hotelowa pościel, drewniana deska, miska cytryn lub jabłek, małe zioło, ręcznik, dozownik mydła albo mała roślina, jeśli pasują do pomieszczenia.",
    "- Podkręć jakość zdjęcia katalogowo, ale realistycznie. To ma być ultra-fotorealistyczne luxury boutique real estate photography, nie remont, nie render, nie CGI.",
    "- Brak HDR, brak CGI, brak renderingu, brak mebli AI, brak fantazyjnego wnętrza, brak fałszywej architektury, brak fałszywego słońca, brak nierealnych cieni, brak wymiany mebli.",
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

async function makePortalJpeg(imageBuffer, outputSize) {
  return sharp(imageBuffer, { limitInputPixels: false })
    .rotate()
    .resize(outputSize.width, outputSize.height, {
      fit: "cover",
      position: "attention",
      withoutEnlargement: false,
    })
    .sharpen()
    .jpeg({
      quality: 95,
      mozjpeg: true,
      chromaSubsampling: "4:4:4",
    })
    .toBuffer();
}

function createOutputFileName(originalName, resolution) {
  const cleanBaseName = path
    .basename(originalName || "zdjecie")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  return `${cleanBaseName || "zdjecie"}-ai-crm-${resolution}-${randomUUID()}.jpg`;
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

function buildAnalysisInstruction(rules) {
  return [
    "Odczytaj zdjęcie nieruchomości dla aplikacji CRM. Odpowiedz po polsku.",
    "Nie projektuj wnętrza i nie wymyślaj zmian. Twoim zadaniem jest precyzyjnie rozpoznać zdjęcie, żeby kolejny krok mógł zbudować prompt jak dla profesjonalnej fotografii nieruchomości.",
    "Nazwij typ pomieszczenia możliwie jednoznacznie, np. łazienka, kuchnia, salon, sypialnia, przedpokój, taras. Jeżeli nie masz pewności, napisz to.",
    "Zwróć krótki opis w sekcjach:",
    "1. Typ pomieszczenia.",
    "2. Co widać: układ, perspektywa, główne stałe elementy i wyposażenie stałe.",
    "3. Zachować dokładnie: architektura, ściany, podłogi, okna, drzwi, zabudowa, meble stałe, sprzęty, armatura, grzejniki, układ i proporcje.",
    "4. Kolory i materiały do zachowania: ściany, płytki, podłogi, meble, zabudowa, sprzęty, metal, drewno, szkło, tkaniny.",
    "5. Rzeczy możliwe do usunięcia: tylko rzeczy osobiste, bałagan, kosmetyki, detergenty, naczynia, ubrania, papiery, butelki, kable i przypadkowe dodatki.",
    "6. Czyszczenie: konkretne powierzchnie, które powinny wyglądać idealnie czysto, np. wanna, umywalka, lustro, armatura, blat, podłoga, fuga, szkło, sprzęty AGD.",
    "7. Subtelny staging pasujący do pokoju: maksymalnie 3-4 małe elementy, tylko jeśli naturalnie pasują.",
    "8. Ostrożność: napisz, czego nie jesteś pewien, zamiast zgadywać.",
    "Nie wskazuj usuwania mebli, dekoracji ani zmiany kolorów, chyba że to są oczywiste rzeczy osobiste lub śmieci.",
    rules ? `Twarde zasady aplikacji:\n${rules}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
