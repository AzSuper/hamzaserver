const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();

require('dotenv').config();
const PORT = process.env.PORT || 5000;

// Enable CORS & JSON Parsing
app.use(cors());
app.use(express.json());

// Database setup
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error('Database Connection Error:', err.message);
  else console.log('Connected to SQLite database.');
});

// Ensure "uploads" directory exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(UPLOAD_DIR, file.fieldname === 'image' ? 'images' : 'pdfs');
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const filename = `${Date.now()}-${file.originalname.replace(/\s/g, '_')}`;
    cb(null, filename);
  }
});

// Multer file filter
const fileFilter = (req, file, cb) => {
  if (file.fieldname === 'pdf' && file.mimetype !== 'application/pdf') {
    return cb(new Error('Only PDF files are allowed'), false);
  }
  if (file.fieldname === 'image' && !['image/jpeg', 'image/png', 'image/jpg'].includes(file.mimetype)) {
    return cb(new Error('Only JPG, JPEG, and PNG images are allowed'), false);
  }
  cb(null, true);
};

// Multer upload configuration
const upload = multer({
  storage: storage,
  fileFilter: fileFilter
}).fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]);

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Create materials table
db.run(`
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    desc TEXT NOT NULL,
    category TEXT NOT NULL,
    pdf_path TEXT NOT NULL,
    image_path TEXT
  )
`);

// Function to check for duplicates
const checkDuplicateMaterial = (name, desc, category, pdf_path, image_path, callback) => {
  const sql = `SELECT * FROM materials WHERE name = ? AND desc = ? AND category = ? AND pdf_path = ? AND (image_path = ? OR image_path IS NULL)`;
  db.get(sql, [name, desc, category, pdf_path, image_path], (err, row) => {
    if (err) return callback(err, null);
    callback(null, row ? true : false);
  });
};

// Route: Add new material
app.post('/api/materials', (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      console.error('File Upload Error:', err.message);
      return res.status(400).json({ error: `Upload Error: ${err.message}` });
    }

    const { name, desc, category } = req.body;
    if (!name || !desc || !category) {
      return res.status(400).json({ error: 'Name, description, and category are required.' });
    }

    const pdfFile = req.files['pdf'] ? req.files['pdf'][0] : null;
    const imageFile = req.files['image'] ? req.files['image'][0] : null;

    if (!pdfFile) {
      return res.status(400).json({ error: 'PDF file is required.' });
    }

    const pdf_path = pdfFile.path;
    const image_path = imageFile ? imageFile.path : null;

    // Check for duplicate
    checkDuplicateMaterial(name, desc, category, pdf_path, image_path, (err, exists) => {
      if (err) {
        console.error('Database Check Error:', err.message);
        return res.status(500).json({ error: `Database Error: ${err.message}` });
      }

      if (exists) {
        return res.status(409).json({ error: 'Material already exists!' });
      }

      // Insert new material if no duplicate found
      const sql = `INSERT INTO materials (name, desc, category, pdf_path, image_path) VALUES (?, ?, ?, ?, ?)`;
      db.run(sql, [name, desc, category, pdf_path, image_path], function (err) {
        if (err) {
          console.error('Database Insert Error:', err.message);
          return res.status(500).json({ error: `Database Error: ${err.message}` });
        }

        res.status(201).json({
          message: 'Material added successfully!',
          material: {
            id: this.lastID,
            name,
            desc,
            category,
            pdf_link: `${req.protocol}://${req.get('host')}/uploads/pdfs/${path.basename(pdf_path)}`,
            image_link: image_path ? `${req.protocol}://${req.get('host')}/uploads/images/${path.basename(image_path)}` : null
          }
        });
      });
    });
  });
});

// Route: Get all materials
app.get('/api/materials', (req, res) => {
  db.all('SELECT * FROM materials', [], (err, rows) => {
    if (err) {
      console.error('Database Fetch Error:', err.message);
      return res.status(500).json({ error: `Database Fetch Error: ${err.message}` });
    }

    res.json(rows.map(row => ({
      ...row,
      pdf_link: `${req.protocol}://${req.get('host')}/uploads/pdfs/${path.basename(row.pdf_path)}`,
      image_link: row.image_path ? `${req.protocol}://${req.get('host')}/uploads/images/${path.basename(row.image_path)}` : null
    })));
  });
});

// Route: Delete material
app.delete('/api/materials/:id', (req, res) => {
  const materialId = req.params.id;

  db.get('SELECT * FROM materials WHERE id = ?', [materialId], (err, row) => {
    if (err || !row) {
      console.error('Material Not Found:', err ? err.message : 'No data');
      return res.status(404).json({ error: 'Material not found.' });
    }

    // Remove files
    if (fs.existsSync(row.pdf_path)) fs.unlinkSync(row.pdf_path);
    if (row.image_path && fs.existsSync(row.image_path)) fs.unlinkSync(row.image_path);

    db.run('DELETE FROM materials WHERE id = ?', [materialId], function (err) {
      if (err) {
        console.error('Database Delete Error:', err.message);
        return res.status(500).json({ error: `Database Delete Error: ${err.message}` });
      }

      res.json({ message: 'Material deleted successfully.' });
    });
  });
});

app.put('/api/materials/:id', (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      console.error('File Upload Error:', err.message);
      return res.status(400).json({ error: `Upload Error: ${err.message}` });
    }

    const materialId = req.params.id;
    const { name, desc, category } = req.body;
    
    if (!name || !desc || !category) {
      return res.status(400).json({ error: 'Name, description, and category are required.' });
    }

    // Get existing material first
    db.get('SELECT * FROM materials WHERE id = ?', [materialId], (err, existingMaterial) => {
      if (err || !existingMaterial) {
        console.error('Material Not Found:', err ? err.message : 'No data');
        return res.status(404).json({ error: 'Material not found.' });
      }

      const pdfFile = req.files['pdf'] ? req.files['pdf'][0] : null;
      const imageFile = req.files['image'] ? req.files['image'][0] : null;

      let newPdfPath = existingMaterial.pdf_path;
      let newImagePath = existingMaterial.image_path;

      // Handle PDF update
      if (pdfFile) {
        // Delete old PDF if it exists
        if (fs.existsSync(existingMaterial.pdf_path)) {
          fs.unlinkSync(existingMaterial.pdf_path);
        }
        newPdfPath = pdfFile.path;
      }

      // Handle image update
      if (imageFile) {
        // Delete old image if it exists
        if (existingMaterial.image_path && fs.existsSync(existingMaterial.image_path)) {
          fs.unlinkSync(existingMaterial.image_path);
        }
        newImagePath = imageFile.path;
      }

      // Update database
      const sql = `
        UPDATE materials 
        SET name = ?, desc = ?, category = ?, pdf_path = ?, image_path = ?
        WHERE id = ?
      `;

      db.run(sql, 
        [name, desc, category, newPdfPath, newImagePath, materialId],
        function(err) {
          if (err) {
            console.error('Database Update Error:', err.message);
            return res.status(500).json({ error: `Database Error: ${err.message}` });
          }

          res.json({
            message: 'Material updated successfully!',
            material: {
              id: materialId,
              name,
              desc,
              category,
              pdf_link: `${req.protocol}://${req.get('host')}/uploads/pdfs/${path.basename(newPdfPath)}`,
              image_link: newImagePath ? 
                `${req.protocol}://${req.get('host')}/uploads/images/${path.basename(newImagePath)}` : null
            }
          });
        }
      );
    });
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
