require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Client } = require('pg');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect();

// Импорт маршрутов
const authRoutes = require('./routes/auth');
const transfersRoutes = require('./routes/transfers');
const paymentsRoutes = require('./routes/payments');

app.use('/auth', authRoutes);
app.use('/transfers', transfersRoutes);
app.use('/payments', paymentsRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});