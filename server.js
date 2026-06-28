const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. CORE MIDDLEWARES
// ==========================================
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

// ==========================================
// 2. MONGOOSE SCHEMAS
// ==========================================
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
    history: [
        {
            date: { type: Date, default: Date.now },
            status: { type: String },
            location: { type: String }
        }
    ]
}, { timestamps: true });

const Shipment = mongoose.model('Shipment', ShipmentSchema);

// ==========================================
// 3. AUTHENTICATION GATE
// ==========================================
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

// ==========================================
// 4. PUBLIC API ENDPOINTS
// ==========================================
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

// ==========================================
// 5. SECURE ADMIN API ENDPOINTS
// ==========================================
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

app.post('/admin/shipments', isAuthenticated, async (req, res) => {
    try {
        const existing = await Shipment.findOne({ trackingNumber: req.body.trackingNumber });
        if (existing) return res.status(400).json({ error: "Tracking number already exists." });

        const newShipment = new Shipment(req.body);
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

app.delete('/admin/shipments/:id', isAuthenticated, async (req, res) => {
    try {
        await Shipment.findByIdAndDelete(req.params.id);
        return res.sendStatus(200);
    } catch (err) {
        return res.status(500).json({ error: "Purge process failed." });
    }
});

// ==========================================
// 6. FRONTEND ROUTING
// ==========================================
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/shipments-page', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.sendFile(path.join(__dirname, 'public', 'admin-shipments.html'));
    }
    return res.redirect('/admin');
});

// Regex catch-all prevents PathError crashes
app.get('('*')', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// 7. BOOTSTRAP
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log("🚀 Connection to cloud MongoDB Atlas instance established.");
        app.listen(PORT, () => console.log(`🌐 System online at http://localhost:${PORT}`));
    })
    .catch(err => console.error("❌ Database connection failed:", err));