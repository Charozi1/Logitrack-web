const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const multer = require('multer'); 
const fs = require('fs'); // Handled for physical file deletions
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure public/uploads directory exists for incoming images
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'secure-fallback-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const SettingsSchema = new mongoose.Schema({
    contactEmail: { type: String, default: '' },
    whatsappNumber: { type: String, default: '' },
    chatScriptUrl: { type: String, default: '' }
}, { timestamps: true });
const Settings = mongoose.model('Settings', SettingsSchema);

const ShipmentSchema = new mongoose.Schema({
    trackingNumber: { type: String, required: true, unique: true },
    customerName: { type: String, required: true },
    origin: { type: String, default: '' },
    destination: { type: String, default: '' },
    transitMode: { type: String, default: 'By Car / Ground Freight' },
    status: { type: String, default: 'Pending' },
    location: { type: String, default: '' },
    packageImage: { type: String, default: '' }, 
    history: [
        {
            date: { type: Date, default: Date.now },
            status: { type: String },
            location: { type: String }
        }
    ]
}, { timestamps: true });
const Shipment = mongoose.model('Shipment', ShipmentSchema);

const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.isAdmin) return next();
    return res.status(401).json({ error: "Unauthorized access." });
};

app.post('/admin/login', async (req, res) => {
    try {
        const { password } = req.body;
        const hash = process.env.ADMIN_HASH;
        if (!hash) return res.status(500).json({ error: "Server misconfiguration." });

        const match = await bcrypt.compare(password, hash);
        if (match) {
            req.session.isAdmin = true;
            return res.sendStatus(200);
        } else {
            return res.status(401).json({ error: "Invalid credentials." });
        }
    } catch (err) {
        return res.status(500).json({ error: "Auth execution breakdown." });
    }
});

app.post('/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ success: false });
        res.clearCookie('connect.sid');
        return res.sendStatus(200);
    });
});

app.get('/settings/public', async (req, res) => {
    try {
        let settings = await Settings.findOne();
        if (!settings) settings = await Settings.create({ contactEmail: '', whatsappNumber: '', chatScriptUrl: '' });
        return res.status(200).json(settings);
    } catch (err) {
        return res.status(500).json({ contactEmail: '', whatsappNumber: '', chatScriptUrl: '' });
    }
});

app.get('/track/:num', async (req, res) => {
    try {
        const shipment = await Shipment.findOne({ trackingNumber: req.params.num });
        if (!shipment) return res.sendStatus(404);
        return res.status(200).json(shipment);
    } catch (err) {
        return res.status(500).json({ error: "Database reading connection drop." });
    }
});

app.get('/admin/settings', isAuthenticated, async (req, res) => {
    try {
        let settings = await Settings.findOne();
        if (!settings) settings = await Settings.create({ contactEmail: '', whatsappNumber: '', chatScriptUrl: '' });
        return res.status(200).json(settings);
    } catch (err) {
        return res.status(500).json({ error: "Failed to load settings." });
    }
});

app.put('/admin/settings', isAuthenticated, async (req, res) => {
    try {
        const { contactEmail, whatsappNumber, chatScriptUrl } = req.body;
        const updated = await Settings.findOneAndUpdate(
            {}, { contactEmail, whatsappNumber, chatScriptUrl }, { new: true, upsert: true }
        );
        return res.status(200).json(updated);
    } catch (err) {
        return res.status(500).json({ error: "Failed updating database." });
    }
});

app.post('/admin/shipments', isAuthenticated, upload.single('packageImage'), async (req, res) => {
    try {
        const existing = await Shipment.findOne({ trackingNumber: req.body.trackingNumber });
        if (existing) return res.status(400).json({ error: "Tracking number already exists." });

        const payload = req.body;
        if (typeof payload.history === 'string') {
            payload.history = JSON.parse(payload.history);
        }
        if (req.file) {
            payload.packageImage = '/uploads/' + req.file.filename;
        }

        const newShipment = new Shipment(payload);
        await newShipment.save();
        return res.sendStatus(200);
    } catch (err) {
        return res.status(500).json({ error: "Database writing dropped out." });
    }
});

app.get('/admin/shipments', isAuthenticated, async (req, res) => {
    try {
        const searchVal = req.query.q || '';
        let queryCondition = {};
        if (searchVal.trim() !== '') {
            queryCondition = {
                $or: [
                    { trackingNumber: { $regex: searchVal, $options: 'i' } },
                    { customerName: { $regex: searchVal, $options: 'i' } }
                ]
            };
        }
        const listings = await Shipment.find(queryCondition).sort({ createdAt: -1 });
        return res.status(200).json(listings);
    } catch (err) {
        return res.status(500).json({ error: "Failed fetching data." });
    }
});

// UPGRADED DELETE ROUTE: Cleans up local directory storage automatically
app.delete('/admin/shipments/:id', isAuthenticated, async (req, res) => {
    try {
        // 1. Locate target document in MongoDB first to check for image references
        const shipment = await Shipment.findById(req.params.id);
        if (!shipment) return res.status(404).json({ error: "Shipment record not found." });

        // 2. If packageImage exists, attempt to wipe it out of hard storage
        if (shipment.packageImage && shipment.packageImage.trim() !== '') {
            // Reconstruct the file path: /uploads/file.png -> ./public/uploads/file.png
            const relativePath = path.join(__dirname, 'public', shipment.packageImage);
            
            if (fs.existsSync(relativePath)) {
                fs.unlinkSync(relativePath); // Permanently delete the file
            }
        }

        // 3. Drop the database entry cleanly
        await Shipment.findByIdAndDelete(req.params.id);
        return res.sendStatus(200);
    } catch (err) {
        return res.status(500).json({ error: "Purge process failed." });
    }
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/shipments-page', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.sendFile(path.join(__dirname, 'public', 'admin-shipments.html'));
    }
    return res.redirect('/admin');
});

app.get('('*')', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log("🚀 Connection to cloud MongoDB Atlas instance established.");
        app.listen(PORT, () => console.log(`🌐 System online at http://localhost:${PORT}`));
    })
    .catch(err => console.error("❌ Database connection failed:", err));