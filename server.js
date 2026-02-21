// server.js — Firestore DB + Firebase Storage (with defaults on create)
// ---------------------------------------------------------------
import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import fs from "fs"; // only for optional service-account path
import admin from "firebase-admin";

const app = express();

// CORS: adjust in prod (e.g., origin: 'https://your.app')
app.use(cors());
app.use(express.json());

/* =========================
   Firebase Admin Init
========================= */
function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const svcFromEnv = process.env.FIREBASE_SERVICE_ACCOUNT; // JSON string
  const svcFromPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH; // path to JSON
  let credential;

  if (svcFromEnv) {
    const serviceAccount = JSON.parse(svcFromEnv);
    if (serviceAccount.private_key?.includes("\\n")) {
      serviceAccount.private_key = serviceAccount.private_key.replace(
        /\\n/g,
        "\n",
      );
    }
    credential = admin.credential.cert(serviceAccount);
  } else if (svcFromPath) {
    const raw = fs.readFileSync(svcFromPath, "utf8");
    const serviceAccount = JSON.parse(raw);
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credential = admin.credential.applicationDefault();
  } else {
    throw new Error(
      "Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT (JSON) or FIREBASE_SERVICE_ACCOUNT_PATH (file), or GOOGLE_APPLICATION_CREDENTIALS.",
    );
  }

  admin.initializeApp({
    credential,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}
initFirebaseAdmin();

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Boot logs for bucket configuration
console.log("[BOOT] Using storage bucket:", bucket?.name || "(none)");
if (!bucket?.name) {
  throw new Error(
    "No default storage bucket. Set FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com",
  );
}

// Verify bucket connectivity & permissions once at startup
(async () => {
  try {
    const [meta] = await bucket.getMetadata();
    console.log("[BOOT] Bucket metadata ok:", meta?.name || bucket.name);
  } catch (e) {
    console.error(
      "[BOOT] Cannot access bucket. Check FIREBASE_STORAGE_BUCKET and IAM:",
      e?.message || e,
    );
  }
})();

/* =========================
   Helpers
========================= */

// Firestore server timestamp
const nowTs = () => admin.firestore.FieldValue.serverTimestamp();

// Normalize image to absolute URL (kept for parity; Firebase returns absolute already)
const toAbsoluteImageUrl = (req, image) => {
  if (!image || !String(image).trim()) return null;
  const src = String(image).trim();
  if (/^https?:\/\//i.test(src)) return src;
  const base = `${req.protocol}://${req.get("host")}`;
  if (src.startsWith("/uploads")) return `${base}${src}`;
  return `${base}/${src.replace(/^\/?/, "")}`;
};

const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

// Signed URL for Storage file (long-lived)
async function getReadUrl(file) {
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: "03-01-2500",
  });
  return url;
}

function makeFileName(original) {
  const ext = path.extname(original || "");
  const base = crypto.randomBytes(16).toString("hex");
  return `${Date.now()}-${base}${ext}`;
}

/* =========================
   Centralized defaults
========================= */
const defaults = {
  user: (over = {}) => ({
    uid: null,
    email: null,
    displayName: null,
    is_validated: false,
    request_sent: false,
    last_score: 0, // 0..100
    Board: "none",
    ExamYEar: 0, // keep original casing
    lastNotified: null,
    createdAt: nowTs(),
    is_Admin: false,
    ...over,
  }),

  exam: (over = {}) => ({
    title: "",
    questionPercentage: 0,
    createdAt: nowTs(),
    ...over,
  }),

  question: (over = {}) => ({
    text: "",
    options: [],
    correctAnswer: 0,
    image: null,
    setId: null,
    setOrder: 0,
    createdAt: nowTs(),
    ...over,
  }),

  note: (over = {}) => ({
    noteName: "",
    fileName: null, // legacy field retained
    originalName: "",
    isPublic: false,
    uploadedBy: null,
    downloadURL: null,
    storagePath: null,
    createdAt: nowTs(),
    ...over,
  }),

  request: (over = {}) => ({
    uid: null,
    transactionId: "",
    createdAt: nowTs(),
    ...over,
  }),

  announcement: (over = {}) => ({
    title: "",
    content: "",
    createdAt: nowTs(),
    updatedAt: null,
    ...over,
  }),
};

// Validate minimal question payload
const validateQuestionPayload = ({ text, options, correctAnswer }) => {
  if (!text || !Array.isArray(options) || options.length < 2) {
    return "Invalid question: 'text' is required and 'options' must have at least 2 items.";
  }
  const idx = Number(correctAnswer);
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
    return "Invalid 'correctAnswer' index.";
  }
  return null;
};

/* =========================
   Firestore "Models" (Collections)
========================= */
const usersCol = db.collection("users");
const examsCol = db.collection("exams");
const notesCol = db.collection("notes"); // all notes
const publicNotesCol = db.collection("public_notes"); // mirror for public notes (no where needed)
const requestsCol = db.collection("requests");
const announcementsCol = db.collection("announcements");

/* =========================
   Utility: Build Exam with Embedded Questions
========================= */
async function getExamWithQuestions(examId) {
  const examRef = examsCol.doc(examId);
  const examSnap = await examRef.get();
  if (!examSnap.exists) return null;

  const exam = { id: examSnap.id, ...examSnap.data() };
  const qSnap = await examRef.collection("questions").get();
  exam.questions = qSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return exam;
}

async function getAllExamsWithQuestions() {
  const snap = await examsCol.get();
  const exams = await Promise.all(
    snap.docs.map(async (d) => {
      const exam = { id: d.id, ...d.data() };
      const qSnap = await examsCol.doc(d.id).collection("questions").get();
      exam.questions = qSnap.docs.map((q) => ({ id: q.id, ...q.data() }));
      return exam;
    }),
  );
  return exams;
}

// --- Add near the top (after app initialization) ---
app.get("/", (req, res) => {
  res.send("OK");
});

app.get("/health", async (req, res) => {
  try {
    // Optional lightweight checks (no need to do heavy I/O each time)
    res.json({ ok: true, time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "health error" });
  }
});

/* =========================
   USER ROUTES
========================= */

app.post("/api/register", async (req, res) => {
  try {
    const { uid, email, displayName, is_Admin } = req.body;
    if (!uid || !email) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const userRef = usersCol.doc(uid);
    const existing = await userRef.get();
    if (existing.exists) {
      return res.status(400).json({ message: "User already exists" });
    }

    const data = defaults.user({
      uid,
      email,
      displayName: displayName || null,
      ...(typeof is_Admin === "boolean" ? { is_Admin } : {}),
    });

    await userRef.set(data);
    const saved = await userRef.get();
    return res.status(201).json({ id: saved.id, ...saved.data() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/users/:uid", async (req, res) => {
  try {
    const snap = await usersCol.doc(req.params.uid).get();
    if (!snap.exists) return res.json(null);
    res.json({ id: snap.id, ...snap.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const snap = await usersCol.get();
    const users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/users/:uid/score", async (req, res) => {
  try {
    const { uid } = req.params;
    const { score } = req.body;

    const ref = usersCol.doc(uid);
    const snap = await ref.get();
    if (!snap.exists)
      return res.status(404).json({ message: "User not found" });

    await ref.update({ last_score: Number(score) || 0 });
    const updated = await ref.get();
    res.json({
      message: "Score updated",
      lastScore: updated.data().last_score,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error updating score" });
  }
});

app.put("/api/users/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const { Board, ExamYEar, is_Admin } = req.body;

    const update = {};
    if (typeof Board === "string") {
      update.Board = Board.trim() || "none";
    }
    if (typeof ExamYEar !== "undefined") {
      const yearNum = Number(ExamYEar) || 0;
      const currentYear = new Date().getFullYear();
      if (yearNum !== 0 && (yearNum < 1980 || yearNum > currentYear + 1)) {
        return res.status(400).json({
          message: `Invalid year. Must be between 1980 and ${currentYear + 1}.`,
        });
      }
      update.ExamYEar = yearNum;
    }
    if (typeof is_Admin === "boolean") {
      update.is_Admin = is_Admin;
    }

    const ref = usersCol.doc(uid);
    const snap = await ref.get();
    if (!snap.exists)
      return res.status(404).json({ message: "User not found" });

    await ref.update(update);
    const updated = await ref.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) {
    console.error("Update user error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =========================
   EXAM ROUTES
========================= */

app.get("/exams", async (req, res) => {
  try {
    const exams = await getAllExamsWithQuestions();
    return res.json(exams);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error fetching exams" });
  }
});

app.post("/exams", async (req, res) => {
  try {
    const { title, questionPercentage } = req.body;
    if (!title) return res.status(400).json({ message: "Title required" });

    const doc = await examsCol.add(
      defaults.exam({
        title,
        questionPercentage: Number(questionPercentage) || 0,
      }),
    );

    const snap = await doc.get();
    return res.status(201).json({ id: snap.id, questions: [], ...snap.data() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error creating exam" });
  }
});

app.put("/exams/:id", async (req, res) => {
  try {
    const { title, questionPercentage } = req.body;

    const ref = examsCol.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists)
      return res.status(404).json({ message: "Exam not found" });

    await ref.update({
      ...(typeof title !== "undefined" ? { title } : {}),
      ...(typeof questionPercentage !== "undefined"
        ? { questionPercentage: Number(questionPercentage) || 0 }
        : {}),
    });

    const updated = await getExamWithQuestions(req.params.id);
    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error updating exam" });
  }
});

app.delete("/exams/:id", async (req, res) => {
  try {
    const ref = examsCol.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists)
      return res.status(404).json({ message: "Exam not found" });

    const qSnap = await ref.collection("questions").get();
    const batch = db.batch();
    qSnap.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(ref);
    await batch.commit();

    return res.json({ message: "Exam deleted successfully" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error deleting exam" });
  }
});

/* =========================
   QUESTION ROUTES (JSON)
========================= */

app.post("/exams/:examId/questions", async (req, res) => {
  try {
    const { examId } = req.params;
    const { text, options, correctAnswer, image, setId, setOrder } = req.body;

    const examRef = examsCol.doc(examId);
    const examSnap = await examRef.get();
    if (!examSnap.exists)
      return res.status(404).json({ message: "Exam not found" });

    const errMsg = validateQuestionPayload({ text, options, correctAnswer });
    if (errMsg) return res.status(400).json({ message: errMsg });

    await examRef.collection("questions").add(
      defaults.question({
        text,
        options,
        correctAnswer: Number(correctAnswer),
        image: image && String(image).trim() ? String(image).trim() : null,
        setId: setId || null,
        setOrder: Number.isFinite(Number(setOrder)) ? Number(setOrder) : 0,
      }),
    );

    const updatedExam = await getExamWithQuestions(examId);
    return res.json(updatedExam);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error adding question" });
  }
});

app.put("/exams/:examId/questions/:questionId", async (req, res) => {
  try {
    const { examId, questionId } = req.params;
    const { text, options, correctAnswer, image, setId, setOrder } = req.body;

    const qRef = examsCol.doc(examId).collection("questions").doc(questionId);
    const qSnap = await qRef.get();
    if (!qSnap.exists)
      return res.status(404).json({ message: "Question not found" });

    const updates = {};
    if (typeof text !== "undefined") updates.text = text;
    if (typeof options !== "undefined") {
      if (!Array.isArray(options) || options.length < 2) {
        return res.status(400).json({
          message: "'options' must be an array with at least 2 items",
        });
      }
      updates.options = options;
    }
    if (typeof correctAnswer !== "undefined") {
      const idx = Number(correctAnswer);
      const current =
        typeof updates.options !== "undefined"
          ? updates.options
          : qSnap.data().options;
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        return res
          .status(400)
          .json({ message: "Invalid 'correctAnswer' index" });
      }
      updates.correctAnswer = idx;
    }
    if (typeof image !== "undefined") {
      updates.image =
        image && String(image).trim() ? String(image).trim() : null;
    }
    if (typeof setId !== "undefined") updates.setId = setId || null;
    if (typeof setOrder !== "undefined") {
      const ord = Number(setOrder);
      if (!Number.isFinite(ord)) {
        return res.status(400).json({ message: "'setOrder' must be a number" });
      }
      updates.setOrder = ord;
    }

    await qRef.update(updates);
    const updatedExam = await getExamWithQuestions(examId);
    return res.json(updatedExam);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error updating question" });
  }
});

app.delete("/exams/:examId/questions/:questionId", async (req, res) => {
  try {
    const { examId, questionId } = req.params;

    const qRef = examsCol.doc(examId).collection("questions").doc(questionId);
    const qSnap = await qRef.get();
    if (!qSnap.exists)
      return res.status(404).json({ message: "Question not found" });

    await qRef.delete();

    const updatedExam = await getExamWithQuestions(examId);
    return res.json({
      message: "Question deleted successfully",
      exam: updatedExam,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error deleting question" });
  }
});

/* =========================
   FILE UPLOADS → Firebase Storage
========================= */

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const isPdfMime = file.mimetype === "application/pdf";
    const isPdfExt = /\.pdf$/i.test(file.originalname || "");
    if (isPdfMime || isPdfExt) return cb(null, true);
    cb(new Error("Only PDF files allowed"));
  },
});

const uploadImage = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test((file.mimetype || "").toLowerCase());
    if (extOk && mimeOk) return cb(null, true);
    cb(new Error("Only image files are allowed (jpeg, jpg, png, gif, webp)"));
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Upload PDF → Storage (returns note; mirrors public notes)
app.post("/api/upload", uploadPdf.single("file"), async (req, res, next) => {
  try {
    const { noteName, isPublic, uploadedBy } = req.body;
    if (!req.file)
      return res.status(400).json({ message: "No file uploaded." });

    const filename = makeFileName(req.file.originalname);
    const storagePath = `notes/${filename}`;
    const file = bucket.file(storagePath);

    console.log(
      "[UPLOAD] Saving to:",
      storagePath,
      "mimetype:",
      req.file.mimetype,
      "size:",
      req.file.size,
    );

    await file.save(req.file.buffer, {
      contentType: req.file.mimetype || "application/pdf",
      metadata: { contentType: req.file.mimetype || "application/pdf" },
      resumable: false,
    });

    console.log("[UPLOAD] Saved to Storage. Getting signed URL…");
    const downloadURL = await getReadUrl(file);
    console.log(
      "[UPLOAD] Signed URL:",
      (downloadURL || "").slice(0, 72),
      "...",
    );

    const payload = defaults.note({
      noteName: noteName || req.file.originalname,
      fileName: null, // legacy field no longer used, kept for compatibility
      originalName: req.file.originalname,
      isPublic: String(isPublic) === "true",
      uploadedBy: uploadedBy || null,
      downloadURL,
      storagePath,
    });

    const mainRef = notesCol.doc();
    const batch = db.batch();
    batch.set(mainRef, payload);

    // Mirror to /public_notes if public
    if (payload.isPublic) {
      const mirrorRef = publicNotesCol.doc(mainRef.id);
      batch.set(mirrorRef, payload);
    }

    await batch.commit();

    const saved = await mainRef.get();
    return res.status(201).json({
      message: "PDF uploaded successfully",
      note: { id: saved.id, ...saved.data() },
    });
  } catch (err) {
    console.error("Upload route error:", err);
    next(err);
  }
});

/* =========================
   QUESTION UPLOAD (multipart) with Image to Storage
========================= */

app.post(
  "/exams/:examId/questions/upload",
  uploadImage.single("image"),
  async (req, res) => {
    try {
      const { examId } = req.params;
      const { text, correctAnswer, setId, setOrder } = req.body;
      let { options } = req.body;

      if (typeof options === "string") {
        try {
          options = JSON.parse(options);
        } catch {
          return res
            .status(400)
            .json({ message: "'options' must be a valid JSON array string" });
        }
      }

      const examRef = examsCol.doc(examId);
      const examSnap = await examRef.get();
      if (!examSnap.exists)
        return res.status(404).json({ message: "Exam not found" });

      const errMsg = validateQuestionPayload({ text, options, correctAnswer });
      if (errMsg) return res.status(400).json({ message: errMsg });

      let imageUrl = null;
      if (req.file) {
        const filename = makeFileName(req.file.originalname);
        const storagePath = `question-images/${filename}`;
        const file = bucket.file(storagePath);

        await file.save(req.file.buffer, {
          contentType: req.file.mimetype,
          metadata: { contentType: req.file.mimetype },
          resumable: false,
        });

        imageUrl = await getReadUrl(file); // absolute signed URL
      }

      await examRef.collection("questions").add(
        defaults.question({
          text,
          options,
          correctAnswer: Number(correctAnswer),
          image: imageUrl,
          setId: setId || null,
          setOrder: Number.isFinite(Number(setOrder)) ? Number(setOrder) : 0,
        }),
      );

      const updatedExam = await getExamWithQuestions(examId);
      return res.json(updatedExam);
    } catch (err) {
      console.error(err);
      if (err instanceof Error) {
        return res.status(400).json({ message: err.message });
      }
      return res.status(500).json({ message: "Error adding question" });
    }
  },
);

app.put(
  "/exams/:examId/questions/:questionId/upload",
  uploadImage.single("image"),
  async (req, res) => {
    try {
      const { examId, questionId } = req.params;
      const { text, correctAnswer, removeImage, setId, setOrder } = req.body;
      let { options } = req.body;

      if (typeof options === "string") {
        try {
          options = JSON.parse(options);
        } catch {
          return res
            .status(400)
            .json({ message: "'options' must be a valid JSON array string" });
        }
      }

      const qRef = examsCol.doc(examId).collection("questions").doc(questionId);
      const qSnap = await qRef.get();
      if (!qSnap.exists)
        return res.status(404).json({ message: "Question not found" });

      const updates = {};
      if (typeof text !== "undefined") updates.text = text;
      if (typeof options !== "undefined") {
        if (!Array.isArray(options) || options.length < 2) {
          return res.status(400).json({
            message: "'options' must be an array with at least 2 items",
          });
        }
        updates.options = options;
      }
      if (typeof correctAnswer !== "undefined") {
        const idx = Number(correctAnswer);
        const current =
          typeof updates.options !== "undefined"
            ? updates.options
            : qSnap.data().options;
        if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
          return res
            .status(400)
            .json({ message: "Invalid 'correctAnswer' index" });
        }
        updates.correctAnswer = idx;
      }

      if (req.file) {
        const filename = makeFileName(req.file.originalname);
        const storagePath = `question-images/${filename}`;
        const file = bucket.file(storagePath);
        await file.save(req.file.buffer, {
          contentType: req.file.mimetype,
          metadata: { contentType: req.file.mimetype },
          resumable: false,
        });
        updates.image = await getReadUrl(file);
      } else if (removeImage === "true") {
        updates.image = null;
      }

      if (typeof setId !== "undefined") updates.setId = setId || null;
      if (typeof setOrder !== "undefined") {
        const ord = Number(setOrder);
        if (!Number.isFinite(ord)) {
          return res
            .status(400)
            .json({ message: "'setOrder' must be a number" });
        }
        updates.setOrder = ord;
      }

      await qRef.update(updates);
      const updatedExam = await getExamWithQuestions(examId);
      return res.json(updatedExam);
    } catch (err) {
      console.error(err);
      if (err instanceof Error) {
        return res.status(400).json({ message: err.message });
      }
      return res.status(500).json({ message: "Error updating question" });
    }
  },
);

/* =========================
   NOTES (no composite index needed)
========================= */

// Public: read from /public_notes (orderBy only)
// Validated: read from /notes (orderBy only)
app.get("/api/notes", async (req, res) => {
  try {
    const { uid } = req.query;

    let isValidated = false;

    if (uid && typeof uid === "string") {
      const userSnap = await usersCol.doc(uid).get();
      isValidated = !!userSnap.data()?.is_validated;
    }

    let snap;

    // VALIDATED USERS → fetch all notes
    if (isValidated) {
      snap = await notesCol.get();
    }

    // PUBLIC USERS → fetch only isPublic notes
    else {
      snap = await notesCol.where("isPublic", "==", true).get();
    }

    // Sort manually by createdAt (DESC)
    const notes = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() ?? 0;
        const tb = b.createdAt?.toMillis?.() ?? 0;
        return tb - ta;
      });

    return res.json(notes);
  } catch (err) {
    console.error("GET /api/notes error:", err?.message || err);
    return res.status(500).json({ message: "Failed to fetch notes" });
  }
});

// Update a note & sync public mirror on isPublic changes or field edits
app.patch("/api/notes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { noteName, isPublic, uploadedBy } = req.body;

    const ref = notesCol.doc(id);
    const snap = await ref.get();
    if (!snap.exists)
      return res.status(404).json({ message: "Note not found" });

    const prev = snap.data();
    const update = {
      ...(typeof noteName === "string" ? { noteName } : {}),
      ...(typeof uploadedBy === "string" ? { uploadedBy } : {}),
      ...(typeof isPublic === "boolean" ? { isPublic } : {}),
      updatedAt: nowTs(),
    };

    const batch = db.batch();
    batch.update(ref, update);

    const newIsPublic =
      typeof isPublic === "boolean" ? isPublic : prev.isPublic;
    const mirrorRef = publicNotesCol.doc(id);

    if (newIsPublic && !prev.isPublic) {
      // Became public → add to mirror
      batch.set(mirrorRef, { ...prev, ...update });
    } else if (!newIsPublic && prev.isPublic) {
      // Became private → remove from mirror
      batch.delete(mirrorRef);
    } else if (newIsPublic && prev.isPublic) {
      // Stays public → update mirror fields
      batch.update(mirrorRef, update);
    }

    await batch.commit();

    const updated = await ref.get();
    return res.json({ id: updated.id, ...updated.data() });
  } catch (err) {
    console.error("PATCH /api/notes/:id error:", err?.message || err);
    return res.status(500).json({ message: "Failed to update note" });
  }
});

// Delete note & mirror (and optionally the file)
app.delete("/api/notes/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const ref = notesCol.doc(id);
    const snap = await ref.get();
    if (!snap.exists)
      return res.status(404).json({ message: "Note not found" });

    const data = snap.data();

    const batch = db.batch();
    batch.delete(ref);
    batch.delete(publicNotesCol.doc(id));
    await batch.commit();

    // Optional: delete GCS file
    if (data?.storagePath) {
      try {
        await bucket.file(data.storagePath).delete({ ignoreNotFound: true });
      } catch (e) {
        console.warn("[DELETE] Storage cleanup warning:", e?.message || e);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/notes/:id error:", err?.message || err);
    return res.status(500).json({ message: "Failed to delete note" });
  }
});

/* =========================
   REQUEST ROUTES
========================= */

app.post("/api/requests", async (req, res) => {
  try {
    const { uid, transactionId } = req.body;

    const userRef = usersCol.doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists)
      return res.status(404).json({ message: "User not found" });

    const user = userSnap.data();
    if (user.request_sent)
      return res.status(400).json({ message: "Request already sent" });

    const batch = db.batch();
    const reqRef = requestsCol.doc();

    batch.set(
      reqRef,
      defaults.request({
        uid,
        transactionId,
      }),
    );
    batch.update(userRef, { request_sent: true });

    await batch.commit();

    const created = await reqRef.get();
    res.status(201).json({ id: created.id, ...created.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/requests", async (req, res) => {
  try {
    const snap = await requestsCol.orderBy("createdAt", "desc").get();

    const requests = await Promise.all(
      snap.docs.map(async (d) => {
        const r = d.data();
        let user = null;
        if (r.uid) {
          const userSnap = await usersCol.doc(r.uid).get();
          if (userSnap.exists) {
            const u = userSnap.data();
            user = {
              displayName: u.displayName || null,
              email: u.email || null,
              uid: r.uid,
            };
          }
        }
        return { id: d.id, ...r, user };
      }),
    );

    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/requests/approve/:id", async (req, res) => {
  try {
    const reqRef = requestsCol.doc(req.params.id);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists)
      return res.status(404).json({ message: "Request not found" });

    const { uid } = reqSnap.data();
    const userRef = usersCol.doc(uid);

    const batch = db.batch();
    batch.update(userRef, { is_validated: true, request_sent: false });
    batch.delete(reqRef);
    await batch.commit();

    res.json({ message: "Approved successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/requests/reject/:id", async (req, res) => {
  try {
    const reqRef = requestsCol.doc(req.params.id);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists)
      return res.status(404).json({ message: "Request not found" });

    const { uid } = reqSnap.data();
    const userRef = usersCol.doc(uid);

    const batch = db.batch();
    batch.update(userRef, { request_sent: false });
    batch.delete(reqRef);
    await batch.commit();

    res.json({ message: "Rejected successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   Announcement ROUTES
========================= */

app.post("/api/announcements/", async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) {
      return res
        .status(400)
        .json({ message: "Title and content are required" });
    }

    const doc = await announcementsCol.add(
      defaults.announcement({
        title,
        content,
      }),
    );
    const snap = await doc.get();
    res.status(201).json({ id: snap.id, ...snap.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/announcements/", async (req, res) => {
  try {
    const snap = await announcementsCol.orderBy("createdAt", "desc").get();
    const announcements = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(announcements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/announcements/:id", async (req, res) => {
  try {
    const { title, content } = req.body;
    const ref = announcementsCol.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists)
      return res.status(404).json({ message: "Announcement not found" });

    await ref.update({
      ...(typeof title !== "undefined" ? { title } : {}),
      ...(typeof content !== "undefined" ? { content } : {}),
      updatedAt: nowTs(),
    });

    const updated = await ref.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/announcements/:id", async (req, res) => {
  try {
    const ref = announcementsCol.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists)
      return res.status(404).json({ message: "Announcement not found" });

    await ref.delete();
    res.json({ message: "Announcement deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   Chapters by IDs (returns exams; keeps naming)
========================= */
app.post("/chapters/byIds", async (req, res) => {
  try {
    const { ids } = req.body; // expects array of exam IDs (strings)
    if (!ids || !ids.length) {
      return res.status(400).json({ message: "No IDs provided" });
    }

    const docs = await Promise.all(
      ids.map(async (id) => {
        const exam = await getExamWithQuestions(id);
        return exam; // null filtered below
      }),
    );

    res.json(docs.filter(Boolean));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/* =========================
   Update User Last Notified
========================= */
app.put("/api/users/:uid/last-notified", async (req, res) => {
  try {
    const { uid } = req.params;

    // ✅ Use authoritative server time (ignore client body)
    const userRef = usersCol.doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) {
      return res.status(404).json({ message: "User not found" });
    }

    // Write server timestamp; prevents client clock drift issues
    await userRef.update({
      lastNotified: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Read back the updated doc
    const updated = await userRef.get();
    const data = updated.data() || {};
    // Convert Firestore Timestamp -> ISO string for the frontend
    const iso =
      data.lastNotified && typeof data.lastNotified.toDate === "function"
        ? data.lastNotified.toDate().toISOString()
        : null;

    return res.status(200).json({
      message: "lastNotified updated",
      uid: updated.id,
      lastNotified: iso, // ✅ frontend-friendly
    });
  } catch (err) {
    console.error("Update lastNotified error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/* =========================
   Count Announcements After Date
========================= */
app.get("/api/announcements/count", async (req, res) => {
  try {
    const { after } = req.query;
    if (!after) {
      return res
        .status(400)
        .json({ message: "'after' query param is required" });
    }

    const afterDate = new Date(after);
    if (Number.isNaN(afterDate.getTime())) {
      return res.status(400).json({ message: "Invalid 'after' date" });
    }

    const q = await announcementsCol
      .where("createdAt", ">", admin.firestore.Timestamp.fromDate(afterDate))
      .get();

    return res.json({ count: q.size, after: afterDate.toISOString() });
  } catch (err) {
    console.error("Count announcements error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/* =========================
   Assembled Exam Endpoint (block-aware, no-split sets)
========================= */
app.get("/exams/assembled", async (req, res) => {
  try {
    const base = Number(req.query.base) > 0 ? Number(req.query.base) : 25;
    const max = Number(req.query.max) > 0 ? Number(req.query.max) : 100;
    const absoluteImages =
      String(req.query.absoluteImages ?? "true").toLowerCase() === "true";

    const exams = await getAllExamsWithQuestions();

    const buildBlocksForExam = (exam) => {
      const groups = new Map();
      const singles = [];

      for (const q of exam.questions || []) {
        if (q?.setId) {
          if (!groups.has(q.setId)) groups.set(q.setId, []);
          groups.get(q.setId).push(q);
        } else {
          singles.push([q]);
        }
      }

      const blocks = [];
      for (const [, arr] of groups.entries()) {
        arr.sort(
          (a, b) =>
            (Number.isFinite(a.setOrder) ? a.setOrder : 0) -
            (Number.isFinite(b.setOrder) ? b.setOrder : 0),
        );
        blocks.push(arr);
      }
      blocks.push(...singles);
      return blocks;
    };

    const pickBlocks = (blocks, target) => {
      if (target <= 0) return [];
      const pool = shuffle(blocks);
      const picked = [];
      let count = 0;

      for (const block of pool) {
        if (count + block.length <= target) {
          picked.push(block);
          count += block.length;
        }
      }

      if (picked.length === 0 && pool.length && target > 0) {
        const smallest = [...pool].sort((a, b) => a.length - b.length)[0];
        picked.push(smallest);
      }
      return picked;
    };

    let allBlocks = [];
    for (const exam of exams) {
      const blocks = buildBlocksForExam(exam);
      const targetCount = Math.round(
        (base * (exam.questionPercentage || 0)) / 100,
      );
      const chosenBlocks = pickBlocks(blocks, targetCount);
      allBlocks.push(...chosenBlocks);
    }

    allBlocks = shuffle(allBlocks);

    const finalQuestions = [];
    let used = 0;
    for (const block of allBlocks) {
      if (used + block.length <= max) {
        finalQuestions.push(...block);
        used += block.length;
      } else if (used === 0) {
        finalQuestions.push(...block);
        break;
      }
    }

    const normalized = finalQuestions.map((q) => {
      const json = q; // already plain object
      if (absoluteImages) {
        json.image = toAbsoluteImageUrl(req, json.image);
      }
      return json;
    });

    res.json({
      base,
      max,
      count: normalized.length,
      questions: normalized,
    });
  } catch (err) {
    console.error("Assemble exam error:", err);
    res.status(500).json({ message: "Server error assembling exam" });
  }
});

/* --------------------
   Legacy static (kept; not used by Firebase uploads)
-------------------- */
app.use("/uploads", express.static("uploads"));

/* =========================
   Global Error Handler
========================= */
app.use((err, req, res, next) => {
  // Multer errors
  if (err && err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") {
      console.error("Multer LIMIT_FILE_SIZE:", err.message);
      return res.status(413).json({ message: "File too large (max 20MB)" });
    }
    console.error("Multer error:", err.message);
    return res.status(400).json({ message: err.message || "Upload error" });
  }

  // Custom filter errors
  if (err && err.message === "Only PDF files allowed") {
    console.error("PDF filter error:", err.message);
    return res.status(400).json({ message: "Only PDF files are allowed" });
  }
  if (err && err.message?.startsWith("Only image files")) {
    console.error("Image filter error:", err.message);
    return res.status(400).json({ message: err.message });
  }

  // GCS/Admin specific
  if (err && (err.code === 403 || err.code === 401)) {
    console.error("GCS/Admin permission error:", err.message);
    return res
      .status(403)
      .json({ message: err.message || "Storage permission error" });
  }

  console.error("Unhandled server error:", err?.message || err);
  res.status(500).json({ message: "Internal Server Error" });
});

/* =========================
   START SERVER
========================= */
const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
