const pythonAPI = require("../../services/python/PythonAPI");
const { dialog, shell, BrowserWindow } = require("electron");
const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");
const { app } = require("electron");
const { TAQEEM_ELECTRON_PARTITION } = require("../../shared/constants/taqeemElectronPartition");

let externalWebWindow = null;

function isTaqeemHost(urlString) {
  try {
    const u = new URL(urlString);
    return (
      u.hostname === "taqeem.gov.sa" ||
      u.hostname.endsWith(".taqeem.gov.sa")
    );
  } catch {
    return false;
  }
}

const workerHandlers = {
  async handlePing() {
    try {
      const result = await pythonAPI.auth.ping();
      return { status: "SUCCESS", result };
    } catch (error) {
      console.error("[MAIN] Ping error:", error);
      return { status: "ERROR", error: error.message };
    }
  },

  async handleWorkerStatus() {
    try {
      const isReady = pythonAPI.isReady();
      return { status: "SUCCESS", isReady };
    } catch (error) {
      console.error("[MAIN] Worker status error:", error);
      return { status: "ERROR", error: error.message };
    }
  },

  async getDummyPdfPath() {
    try {
      const fs = require("fs").promises; // Use promises version

      // For development
      if (process.env.NODE_ENV === "development") {
        const devPath = path.join(
          process.cwd(),
          "public",
          "dummy_placeholder.pdf",
        );
        // Check if file exists - use await
        try {
          await fs.access(devPath);
          console.log("[MAIN] Found dummy PDF at dev path:", devPath);
          return { status: "SUCCESS", path: devPath };
        } catch (e) {
          console.warn("Development dummy PDF not found at:", devPath);
        }
      }

      // For production - check multiple possible locations
      const possiblePaths = [
        path.join(process.resourcesPath, "dummy_placeholder.pdf"),
        path.join(process.resourcesPath, "app.asar", "dummy_placeholder.pdf"),
        path.join(process.resourcesPath, "app", "dummy_placeholder.pdf"),
        path.join(__dirname, "../../assets/dummy_placeholder.pdf"),
        path.join(__dirname, "../../../assets/dummy_placeholder.pdf"),
        path.join(__dirname, "../../public/dummy_placeholder.pdf"),
        path.join(__dirname, "../../../public/dummy_placeholder.pdf"),
        path.join(__dirname, "../../../../public/dummy_placeholder.pdf"),
      ];

      for (const testPath of possiblePaths) {
        try {
          await fs.access(testPath);
          console.log("[MAIN] Found dummy PDF at:", testPath);
          return testPath;
        } catch (e) {
          // File doesn't exist at this path, try next
          continue;
        }
      }

      throw new Error("Dummy PDF not found in any expected location");
    } catch (error) {
      console.error("[MAIN] Get dummy PDF path error:", error);
      return { status: "ERROR", error: error.message };
    }
  },
  async showOpenDialog() {
    try {
      const { cancelled, filePaths } = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Excel Files", extensions: ["xlsx", "xls"] }],
      });
      return { status: "SUCCESS", filePaths, cancelled };
    } catch (error) {
      console.error("[MAIN] Open dialog error:", error);
      return { status: "ERROR", error: error.message };
    }
  },

  async showOpenDialogWord() {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Word Documents", extensions: ["docx", "doc"] }],
      });
      return { status: "SUCCESS", filePaths, canceled };
    } catch (error) {
      console.error("[MAIN] Open Word dialog error:", error);
      return { status: "ERROR", error: error.message };
    }
  },

  async showOpenDialogPdfs() {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });

      console.log("filePaths", filePaths);

      // Return full paths array
      return { status: "SUCCESS", filePaths, canceled };
    } catch (error) {
      console.error("[MAIN] Open PDF dialog error:", error);
      return { status: "ERROR", error: error.message };
    }
  },

  async showOpenDialogImages() {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "gif"] },
        ],
      });
      return { status: "SUCCESS", filePaths, canceled };
    } catch (error) {
      console.error("[MAIN] Open image dialog error:", error);
      return { status: "ERROR", error: error.message };
    }
  },
  async selectFolder() {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "multiSelections"],
    });

    if (!result.canceled) {
      return { folderPath: result.filePaths[0] };
    }
    return null;
  },

  async readFolder(event, folderPath) {
    try {
      const fs = require("fs").promises;
      const path = require("path");

      // Function to recursively read directory
      const readDirRecursive = async (dir) => {
        const items = await fs.readdir(dir);
        const files = [];

        for (const item of items) {
          const fullPath = path.join(dir, item);
          const stat = await fs.stat(fullPath);

          if (stat.isDirectory()) {
            // Recursively read subdirectory
            const subFiles = await readDirRecursive(fullPath);
            files.push(...subFiles);
          } else if (stat.isFile()) {
            // Only include Excel and PDF files
            const ext = path.extname(item).toLowerCase();
            if ([".xlsx", ".xls", ".pdf"].includes(ext)) {
              files.push({
                name: item,
                path: fullPath,
                size: stat.size,
                lastModified: stat.mtimeMs,
                type:
                  ext === ".pdf"
                    ? "application/pdf"
                    : ext === ".xlsx"
                      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      : "application/vnd.ms-excel",
              });
            }
          }
        }

        return files;
      };

      // Read the folder recursively
      const files = await readDirRecursive(folderPath);

      return {
        files: files,
        folderPath: folderPath,
        count: files.length,
      };
    } catch (error) {
      console.error("[MAIN] Read folder error:", error);
      return {
        files: [],
        folderPath: folderPath,
        error: error.message,
      };
    }
  },

  async readFile(event, filePath) {
    try {
      const fs = require("fs").promises;
      const buffer = await fs.readFile(filePath);
      return {
        success: true,
        data: buffer,
        // Convert to Array for IPC transmission
        arrayBuffer: Array.from(buffer),
      };
    } catch (error) {
      console.error("[MAIN] Read file error:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  },

  async readTemplateFile(event, fileName = "multi-excel-template.xlsx") {
    try {
      const fs = require("fs").promises;
      const path = require("path");

      // Get the app path
      const appPath = app.getAppPath();

      // Try different possible locations for the public folder
      const possiblePaths = [
        path.join(appPath, "public", fileName), // Development (not packaged)
        path.join(appPath, "dist", "public", fileName), // Production (packaged)
        path.join(process.resourcesPath, "app", "public", fileName), // Packaged alternative
        path.join(process.resourcesPath, "app.asar", "public", fileName), // Packaged asar
        path.join(__dirname, "../../public", fileName), // Relative to handlers
        path.join(__dirname, "../../../public", fileName), // Alternative relative
      ];

      let filePath = null;
      for (const testPath of possiblePaths) {
        try {
          await fs.access(testPath);
          filePath = testPath;
          break;
        } catch (e) {
          // File doesn't exist at this path, try next
          continue;
        }
      }

      if (!filePath) {
        throw new Error(
          `Template file ${fileName} not found in any expected location`,
        );
      }

      const buffer = await fs.readFile(filePath);
      return {
        success: true,
        data: buffer,
        arrayBuffer: Array.from(buffer),
      };
    } catch (error) {
      console.error("[MAIN] Read template file error:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  },

  async openExternal(event, url) {
    try {
      if (!url || typeof url !== "string") {
        throw new Error("Invalid URL provided");
      }
      await shell.openExternal(url);
      return { status: "SUCCESS" };
    } catch (error) {
      console.error("[MAIN] Open external error:", error);
      return { status: "ERROR", error: error.message };
    }
  },

  async openWebWindow(event, payload = {}) {
    try {
      const options =
        typeof payload === "string" ? { url: payload } : payload || {};
      const targetUrl = String(options.url || "").trim();
      const title =
        typeof options.title === "string" && options.title.trim()
          ? options.title.trim()
          : "Browser";

      if (!targetUrl) {
        throw new Error("Invalid URL provided");
      }
      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        throw new Error("URL must start with http:// or https://");
      }

      const wantsTaqeemPartition = isTaqeemHost(targetUrl);

      if (externalWebWindow && !externalWebWindow.isDestroyed()) {
        const currentPart = String(
          externalWebWindow.webContents?.session?.partition || "",
        );
        const hasTaqeemPartition =
          currentPart === TAQEEM_ELECTRON_PARTITION;
        if (wantsTaqeemPartition !== hasTaqeemPartition) {
          try {
            externalWebWindow.destroy();
          } catch (_) {
            /* ignore */
          }
          externalWebWindow = null;
        }
      }

      if (externalWebWindow && !externalWebWindow.isDestroyed()) {
        externalWebWindow.setTitle(title);
        await externalWebWindow.loadURL(targetUrl);
        externalWebWindow.show();
        externalWebWindow.focus();
        return { status: "SUCCESS" };
      }

      externalWebWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 1000,
        minHeight: 700,
        show: false,
        autoHideMenuBar: true,
        title,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          ...(wantsTaqeemPartition
            ? { partition: TAQEEM_ELECTRON_PARTITION }
            : {}),
        },
      });

      externalWebWindow.on("closed", () => {
        externalWebWindow = null;
      });

      await externalWebWindow.loadURL(targetUrl);
      externalWebWindow.show();
      externalWebWindow.focus();
      return { status: "SUCCESS" };
    } catch (error) {
      console.error("[MAIN] Open web window error:", error);
      return { status: "ERROR", error: error.message };
    }
  },

  async downloadImage(event, { url, filename }) {
    try {
      if (!url || typeof url !== "string") {
        throw new Error("Invalid URL provided");
      }

      // Get download path
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: "Save Image",
        defaultPath: filename || `haraj-image-${Date.now()}.jpg`,
        filters: [
          { name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      if (canceled || !filePath) {
        return { status: "CANCELED" };
      }

      // Download the image
      return new Promise((resolve, reject) => {
        const protocol = url.startsWith("https:") ? https : http;
        const file = fs.createWriteStream(filePath);

        protocol
          .get(url, (response) => {
            if (response.statusCode !== 200) {
              file.close();
              fs.unlinkSync(filePath);
              reject(new Error(`Failed to download: ${response.statusCode}`));
              return;
            }

            response.pipe(file);

            file.on("finish", () => {
              file.close();
              resolve({ status: "SUCCESS", filePath });
            });

            file.on("error", (err) => {
              file.close();
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
              }
              reject(err);
            });
          })
          .on("error", (err) => {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            reject(err);
          });
      });
    } catch (error) {
      console.error("[MAIN] Download image error:", error);
      return { status: "ERROR", error: error.message };
    }
  },

  async showImageWindow(event, url) {
    try {
      // Handle both string URLs and objects
      let imageUrl = url;
      if (typeof url === "object" && url !== null) {
        imageUrl =
          url.url || url.src || url.link || url.image || url.imageUrl || "";
      } else if (typeof url !== "string") {
        imageUrl = String(url);
      }

      if (!imageUrl || typeof imageUrl !== "string" || imageUrl.trim() === "") {
        throw new Error("Invalid URL provided");
      }

      // Ensure URL is properly formatted
      imageUrl = imageUrl.trim();
      if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
        throw new Error("URL must start with http:// or https://");
      }

      // Create a simple HTML page to display the image
      const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Image Viewer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: #000;
            overflow: hidden;
        }
        img {
            max-width: 100%;
            max-height: 100vh;
            object-fit: contain;
        }
        .error {
            color: white;
            text-align: center;
            padding: 20px;
            font-family: Arial, sans-serif;
        }
    </style>
</head>
<body>
    <img src="${imageUrl.replace(/"/g, "&quot;").replace(/'/g, "&#39;")}" alt="Image"
         onerror="this.style.display='none'; document.body.innerHTML='<div class=\\'error\\'><h2>Failed to load image</h2><p>URL: ${imageUrl.substring(0, 100)}...</p></div>'">
</body>
</html>`;

      const imageWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false, // Allow loading external images
        },
        title: "Image Viewer",
      });

      imageWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`,
      );

      imageWindow.on("closed", () => {
        // Window closed
      });

      return { status: "SUCCESS" };
    } catch (error) {
      console.error("[MAIN] Show image window error:", error);
      return { status: "ERROR", error: error.message };
    }
  },
};

module.exports = workerHandlers;
