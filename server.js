// server.js - VERSIÓN CORREGIDA Y UNIFICADA (Todo usa 'imagen_url')
require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const MAX_ASIENTOS_FUNCION = 80;
const PUNTOS_POR_ENTRADA = 50;
const PUNTOS_ENTRADA_GRATIS = 5000;

// ==================== CONFIGURAR MULTER ====================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'imagenes');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Solo se permiten imágenes (jpeg, jpg, png, gif)'));
        }
    }
});

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());
// Servir archivos estáticos correctamente: 'uploads/imagenes' se accede vía '/imagenes'
app.use('/imagenes', express.static(path.join(__dirname, 'uploads', 'imagenes')));
app.use(express.static(__dirname));

// ==================== CONFIGURACIÓN DB ====================
const dbConfig = {
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || '211011',
    server: process.env.DB_SERVER || 'localhost',
    database: process.env.DB_DATABASE || 'CinetecaDB',
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true
    }
};

let pool;

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'Token requerido' });
    }

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
        req.user = payload;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
}

async function initDB() {
    try {
        pool = await sql.connect(dbConfig);
        console.log('✅ Conectado a SQL Server');

        // Tabla Usuarios
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Usuarios' AND xtype='U')
            CREATE TABLE Usuarios (
                id INT IDENTITY(1,1) PRIMARY KEY,
                nombre NVARCHAR(100),
                email NVARCHAR(150) UNIQUE NOT NULL,
                password NVARCHAR(255) NOT NULL,
                rol NVARCHAR(20) NOT NULL DEFAULT 'consultor'
            )
        `);

        await pool.request().query(`
            IF COL_LENGTH('Usuarios', 'puntos') IS NULL
                ALTER TABLE Usuarios ADD puntos INT NOT NULL DEFAULT 0
        `);

        await pool.request().query(`
            IF COL_LENGTH('Usuarios', 'saldo') IS NULL
                ALTER TABLE Usuarios ADD saldo DECIMAL(10,2) NOT NULL DEFAULT 0.00
        `);

        // Tabla Peliculas - --- CORRECCIÓN --- Usar 'imagen_url'
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Peliculas' AND xtype='U')
            CREATE TABLE Peliculas (
                id INT IDENTITY(1,1) PRIMARY KEY,
                Titulo NVARCHAR(200) NOT NULL,
                
                Genero NVARCHAR(100),
                Duracion INT,
                Pais NVARCHAR(100) DEFAULT 'Desconocido',
                Director NVARCHAR(150),
                Sinopsis NVARCHAR(MAX),
                imagen_url NVARCHAR(255) DEFAULT '/imagenes/default.jpg'
            )
        `);

        // Tabla Salas
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Salas' AND xtype='U')
            CREATE TABLE Salas (
                id INT IDENTITY(1,1) PRIMARY KEY,
                nombre NVARCHAR(100) NOT NULL,
                capacidad INT NOT NULL,
                tecnologia NVARCHAR(200)
            )
        `);

        // Tabla Funciones
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Funciones' AND xtype='U')
            CREATE TABLE Funciones (
                id INT IDENTITY(1,1) PRIMARY KEY,
                peliculaId INT NOT NULL,
                salaId INT NOT NULL,
                fecha DATE NOT NULL,
                hora TIME NOT NULL,
                precio DECIMAL(10, 2) NOT NULL DEFAULT 15.00,
                asientosDisponibles INT NOT NULL DEFAULT 100,
                FOREIGN KEY (peliculaId) REFERENCES Peliculas(id) ON DELETE CASCADE,
                FOREIGN KEY (salaId) REFERENCES Salas(id) ON DELETE CASCADE
            )
        `);

        await pool.request().query(`
            UPDATE Funciones
            SET asientosDisponibles = ${MAX_ASIENTOS_FUNCION}
            WHERE asientosDisponibles > ${MAX_ASIENTOS_FUNCION}
        `);

        // Tabla Boletos comprados por función/asiento
        await pool.request().query(`
            IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Boletos' AND xtype='U')
            CREATE TABLE Boletos (
                id INT IDENTITY(1,1) PRIMARY KEY,
                funcionId INT NOT NULL,
                usuarioId INT NOT NULL,
                asiento NVARCHAR(5) NOT NULL,
                fechaCompra DATETIME2 NOT NULL DEFAULT GETDATE(),
                FOREIGN KEY (funcionId) REFERENCES Funciones(id) ON DELETE CASCADE,
                FOREIGN KEY (usuarioId) REFERENCES Usuarios(id) ON DELETE CASCADE,
                CONSTRAINT UQ_Boletos_Funcion_Asiento UNIQUE (funcionId, asiento)
            )
        `);

        await pool.request().query(`
            IF COL_LENGTH('Boletos', 'usuarioId') IS NULL
                ALTER TABLE Boletos ADD usuarioId INT NULL
        `);

        await pool.request().query(`
            IF COL_LENGTH('Boletos', 'fechaCompra') IS NULL
                ALTER TABLE Boletos ADD fechaCompra DATETIME2 NULL
        `);

        await pool.request().query(`
            IF EXISTS (SELECT 1 FROM Boletos WHERE usuarioId IS NULL)
            BEGIN
                DECLARE @defaultUserId INT = (SELECT TOP 1 id FROM Usuarios ORDER BY id);
                IF @defaultUserId IS NOT NULL
                    UPDATE Boletos SET usuarioId = @defaultUserId WHERE usuarioId IS NULL;
            END
        `);

        await pool.request().query(`
            IF EXISTS (SELECT 1 FROM Boletos WHERE fechaCompra IS NULL)
                UPDATE Boletos SET fechaCompra = GETDATE() WHERE fechaCompra IS NULL
        `);

        await pool.request().query(`
            IF EXISTS (SELECT 1 FROM Boletos WHERE usuarioId IS NULL)
                DELETE FROM Boletos WHERE usuarioId IS NULL
        `);

        await pool.request().query(`
            IF EXISTS (SELECT 1 FROM Boletos WHERE fechaCompra IS NULL)
                UPDATE Boletos SET fechaCompra = GETDATE() WHERE fechaCompra IS NULL
        `);

        await pool.request().query(`
            IF COL_LENGTH('Boletos', 'usuarioId') IS NOT NULL
                ALTER TABLE Boletos ALTER COLUMN usuarioId INT NOT NULL
        `);

        await pool.request().query(`
            IF COL_LENGTH('Boletos', 'fechaCompra') IS NOT NULL
                ALTER TABLE Boletos ALTER COLUMN fechaCompra DATETIME2 NOT NULL
        `);

        await pool.request().query(`
            IF COL_LENGTH('Boletos', 'fechaCompra') IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM sys.default_constraints dc
                INNER JOIN sys.columns c ON c.default_object_id = dc.object_id
                INNER JOIN sys.tables t ON t.object_id = c.object_id
                WHERE t.name = 'Boletos' AND c.name = 'fechaCompra'
            )
                ALTER TABLE Boletos ADD CONSTRAINT DF_Boletos_fechaCompra DEFAULT GETDATE() FOR fechaCompra
        `);

        console.log('✅ Tablas listas');
    } catch (err) {
        console.error('❌ Error DB:', err.message);
    }
}

// ====================== AUTH ======================
app.post('/api/auth/register', async (req, res) => {
    const { nombre, email, password } = req.body;
    try {
        const hashed = await bcrypt.hash(password, 10);
        await pool.request()
            .input('nombre', sql.NVarChar, nombre)
            .input('email', sql.NVarChar, email)
            .input('password', sql.NVarChar, hashed)
            .query(`INSERT INTO Usuarios (nombre, email, password, rol) VALUES (@nombre, @email, @password, 'consultor')`);
        res.status(201).json({ message: 'Usuario registrado correctamente' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.request()
            .input('email', sql.NVarChar, email)
            .query('SELECT * FROM Usuarios WHERE email = @email');

        const user = result.recordset[0];
        if (!user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

        const token = jwt.sign(
            { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
            process.env.JWT_SECRET || 'secret_key',
            { expiresIn: '8h' }
        );

        res.json({
            token,
            usuario: {
                id: user.id,
                nombre: user.nombre,
                email: user.email,
                rol: user.rol,
                puntos: Number.isFinite(user.puntos) ? user.puntos : 0,
                saldo: parseFloat(user.saldo) || 0
            }
        });
    } catch (err) {
        console.error('Error en login:', err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const result = await pool.request()
            .input('id', sql.Int, req.user.id)
            .query('SELECT id, nombre, email, rol, puntos, saldo FROM Usuarios WHERE id = @id');

        const user = result.recordset[0];
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        return res.json({
            usuario: {
                id: user.id,
                nombre: user.nombre,
                email: user.email,
                rol: user.rol,
                puntos: Number.isFinite(user.puntos) ? user.puntos : 0,
                saldo: parseFloat(user.saldo) || 0
            }
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ====================== USUARIOS ======================
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await pool.request().query('SELECT id, nombre, email, rol FROM Usuarios ORDER BY id DESC');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/usuarios', async (req, res) => {
    const { nombre, email, password, rol } = req.body;
    try {
        const hashed = await bcrypt.hash(password, 10);
        const result = await pool.request()
            .input('nombre', sql.NVarChar, nombre)
            .input('email', sql.NVarChar, email)
            .input('password', sql.NVarChar, hashed)
            .input('rol', sql.NVarChar, rol || 'consultor')
            .query(`INSERT INTO Usuarios (nombre, email, password, rol) OUTPUT INSERTED.* VALUES (@nombre, @email, @password, @rol)`);
        res.status(201).json(result.recordset[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM Usuarios WHERE id = @id');
        res.json({ message: 'Usuario eliminado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, email, rol } = req.body;
    try {
        await pool.request()
            .input('id', sql.Int, id)
            .input('nombre', sql.NVarChar, nombre)
            .input('email', sql.NVarChar, email)
            .input('rol', sql.NVarChar, rol)
            .query(`UPDATE Usuarios SET nombre = @nombre, email = @email, rol = @rol WHERE id = @id`);
        
        const result = await pool.request()
            .input('id', sql.Int, id)
            .query('SELECT id, nombre, email, rol FROM Usuarios WHERE id = @id');
        
        res.json(result.recordset[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== PELÍCULAS ======================
app.get('/api/peliculas', async (req, res) => {
    try {
        // --- CORRECCIÓN --- Seleccionar 'imagen_url'
        const result = await pool.request().query('SELECT id, Titulo,  Genero, Duracion, imagen_url FROM Peliculas ORDER BY id DESC');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/peliculas', upload.single('imagen'), async (req, res) => {
    // --- CORRECCIÓN --- FormData envía strings, limpiar antes de enviar a SQL
    const { Titulo,  Genero, Duracion } = req.body;
    
    
    const parsedDuracion = Duracion ? parseInt(Duracion) : 0;

    let imagen_url = '/imagenes/default.jpg'; // Ruta relativa por defecto

    if (req.file) {
        // Guardar solo la ruta relativa en la DB
        imagen_url = `/imagenes/${req.file.filename}`;
    }

    try {
        const result = await pool.request()
            .input('Titulo', sql.NVarChar, Titulo)
           
            .input('Genero', sql.NVarChar, Genero)
            .input('Duracion', sql.Int, parsedDuracion)
            .input('imagen_url', sql.NVarChar, imagen_url) // --- CORRECCIÓN --- Usar 'imagen_url'
            .query(`
                INSERT INTO Peliculas (Titulo,  Genero, Duracion, imagen_url)
                OUTPUT INSERTED.*
                VALUES (@Titulo,  @Genero, @Duracion, @imagen_url)
            `);
        res.status(201).json(result.recordset[0]);
    } catch (err) {
        console.error('Error al insertar película:', err);
        // Si hubo error y se subió foto, borrarla
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Error interno al guardar la película' });
    }
});

app.delete('/api/peliculas/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Intentamos borrar. 
        // Nota: Si esto falla es porque tienes Funciones amarradas a esta película en la DB.
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM Peliculas WHERE id = @id');
            
        res.json({ message: 'Película eliminada correctamente' });
    } catch (err) {
        console.error("Error al eliminar película:", err.message);
        // Si el error es por llave foránea, mandamos un mensaje más claro
        if (err.message.includes('REFERENCE constraint')) {
            return res.status(400).json({ error: 'No se puede eliminar: Esta película tiene funciones programadas.' });
        }
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// --- CORRECCIÓN CRÍTICA --- Ruta PUT para editar (Mantiene la imagen vieja si no subes una nueva)
app.put('/api/peliculas/:id', upload.single('imagen'), async (req, res) => {
    const { id } = req.params;
    const { Titulo,Genero, Duracion } = req.body;

    
    const parsedDuracion = Duracion ? parseInt(Duracion) : 0;

    try {
        // 1. Obtener la película actual de la DB
        const currentMovieResult = await pool.request()
            .input('id', sql.Int, id)
            .query('SELECT imagen_url FROM Peliculas WHERE id = @id');
        
        if (currentMovieResult.recordset.length === 0) {
            return res.status(404).json({ error: 'Película no encontrada' });
        }

        const currentImageUrl = currentMovieResult.recordset[0].imagen_url;
        let finalImageUrl = currentImageUrl; // Por defecto mantemos la actual

        // 2. Determinar la nueva URL de la imagen
        if (req.file) {
            // Se subió una NUEVA foto
            finalImageUrl = `/imagenes/${req.file.filename}`;

            // Borrar la foto VIEJA física (si no es la por defecto)
            if (currentImageUrl && currentImageUrl !== '/imagenes/default.jpg') {
                const oldFilename = currentImageUrl.split('/').pop();
                const oldFilePath = path.join(__dirname, 'uploads', 'imagenes', oldFilename);
                if (fs.existsSync(oldFilePath)) {
                    fs.unlinkSync(oldFilePath);
                }
            }
        } 

        // 3. Actualizar en la base de datos
        await pool.request()
            .input('id', sql.Int, id)
            .input('Titulo', sql.NVarChar, Titulo)
            
            .input('Genero', sql.NVarChar, Genero)
            .input('Duracion', sql.Int, parsedDuracion)
            .input('imagen_url', sql.NVarChar, finalImageUrl) // Actualizamos con la URL definitiva
            .query(`
                UPDATE Peliculas 
                SET Titulo = @Titulo, Genero = @Genero, Duracion = @Duracion, imagen_url = @imagen_url 
                WHERE id = @id
            `);

        // Devolver la película actualizada
        const result = await pool.request()
            .input('id', sql.Int, id)
            .query('SELECT * FROM Peliculas WHERE id = @id');

        res.json(result.recordset[0]);
    } catch (err) {
        console.error('Error al actualizar película:', err);
        // Si hubo error y se subió foto nueva, borrarla
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Error interno al actualizar la película' });
    }
});

// ====================== SALAS ======================
app.get('/api/salas', async (req, res) => {
    try {
        const result = await pool.request().query('SELECT * FROM Salas ORDER BY id DESC');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/salas', async (req, res) => {
    const { nombre, capacidad, tecnologia } = req.body;
    try {
        const result = await pool.request()
            .input('nombre', sql.NVarChar, nombre)
            .input('capacidad', sql.Int, capacidad)
            .input('tecnologia', sql.NVarChar, tecnologia)
            .query(`
                INSERT INTO Salas (nombre, capacidad, tecnologia)
                OUTPUT INSERTED.*
                VALUES (@nombre, @capacidad, @tecnologia)
            `);
        res.status(201).json(result.recordset[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/salas/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM Salas WHERE id = @id');
        res.json({ message: 'Sala eliminada' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/salas/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, capacidad, tecnologia } = req.body;
    try {
        await pool.request()
            .input('id', sql.Int, id)
            .input('nombre', sql.NVarChar, nombre)
            .input('capacidad', sql.Int, capacidad)
            .input('tecnologia', sql.NVarChar, tecnologia)
            .query(`UPDATE Salas SET nombre = @nombre, capacidad = @capacidad, tecnologia = @tecnologia WHERE id = @id`);

        const result = await pool.request()
            .input('id', sql.Int, id)
            .query('SELECT * FROM Salas WHERE id = @id');

        res.json(result.recordset[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== FUNCIONES ======================
// ====================== FUNCIONES ======================
// ====================== FUNCIONES ======================
app.get('/api/funciones', async (req, res) => {
    try {
        const { fecha } = req.query;   // ejemplo: ?fecha=2026-04-01

        let sqlQuery = `
            SELECT 
                f.id,
                f.peliculaId,
                f.salaId,
                CONVERT(VARCHAR(10), f.fecha, 23) as fecha,
                CONVERT(VARCHAR(8), f.hora, 108) as hora,
                f.precio,
                f.asientosDisponibles,
                p.Titulo as peliculaTitulo,
                p.imagen_url,
                p.Genero,
                p.Duracion,
                s.nombre as salaNombre,
                s.tecnologia
            FROM Funciones f
            LEFT JOIN Peliculas p ON f.peliculaId = p.id
            LEFT JOIN Salas s ON f.salaId = s.id
        `;

        const request = pool.request();

        if (fecha) {
            sqlQuery += ` WHERE f.fecha = @fecha`;
            request.input('fecha', sql.Date, fecha);
        }

        sqlQuery += ` ORDER BY f.fecha, f.hora`;

        const result = await request.query(sqlQuery);
        res.json(result.recordset);
    } catch (err) {
        console.error('❌ Error en GET funciones:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/funciones', async (req, res) => {
    const { peliculaId, salaId, fecha, hora, precio, asientosDisponibles } = req.body;
    
    if (!peliculaId || !salaId || !fecha || !hora || !precio) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }

    try {
        // ✅ CONVERTIR HORA CORRECTAMENTE A FORMATO HH:mm:ss
        let horaFormato = hora;
        
        if (typeof hora === 'string') {
            // Si viene en formato HH:mm, agregar :00
            if (hora.length === 5 && hora.match(/^\d{2}:\d{2}$/)) {
                horaFormato = `${hora}:00`;
            }
        }

        // ✅ VALIDAR FORMATO FINAL
        if (!/^\d{2}:\d{2}:\d{2}$/.test(horaFormato)) {
            console.error('❌ Formato de hora inválido:', horaFormato);
            return res.status(400).json({ error: 'Formato de hora inválido. Debe ser HH:mm:ss' });
        }

        // ✅ CONVERTIR FECHA CORRECTAMENTE
        const fechaObj = new Date(fecha);
        if (isNaN(fechaObj.getTime())) {
            return res.status(400).json({ error: 'Formato de fecha inválido' });
        }

        console.log('✅ Datos a insertar:');
        console.log('  - Película ID:', peliculaId);
        console.log('  - Sala ID:', salaId);
        console.log('  - Fecha:', fechaObj.toISOString().split('T')[0]);
        console.log('  - Hora:', horaFormato);
        console.log('  - Precio:', precio);

        // ✅ USAR CAST EN LA CONSULTA PARA CONVERTIR A TIME
        const parsedAsientos = parseInt(asientosDisponibles, 10);
        const asientosFinales = Number.isFinite(parsedAsientos) && parsedAsientos > 0 ? parsedAsientos : MAX_ASIENTOS_FUNCION;

        if (asientosFinales > MAX_ASIENTOS_FUNCION) {
            return res.status(400).json({ error: `Máximo ${MAX_ASIENTOS_FUNCION} asientos por función` });
        }

        const result = await pool.request()
            .input('peliculaId', sql.Int, parseInt(peliculaId))
            .input('salaId', sql.Int, parseInt(salaId))
            .input('fecha', sql.Date, fechaObj)
            .input('hora', sql.VarChar, horaFormato) // ✅ Pasar como VarChar
            .input('precio', sql.Decimal(10, 2), parseFloat(precio))
            .input('asientosDisponibles', sql.Int, asientosFinales)
            .query(`
                INSERT INTO Funciones (peliculaId, salaId, fecha, hora, precio, asientosDisponibles)
                OUTPUT INSERTED.*
                VALUES (@peliculaId, @salaId, @fecha, CAST(@hora AS TIME), @precio, @asientosDisponibles)
            `);
        
        res.status(201).json(result.recordset[0]);
        console.log('✅ Función creada correctamente');
        
    } catch (err) {
        console.error('❌ Error en POST funciones:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/funciones/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM Funciones WHERE id = @id');
        res.json({ message: 'Función eliminada' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/funciones/:id', async (req, res) => {
    const { id } = req.params;
    const { fecha, hora, precio, asientosDisponibles } = req.body;
    
    try {
        // ✅ VALIDAR Y CONVERTIR HORA
        let horaFormato = hora;
        if (typeof hora === 'string' && hora.length === 5 && hora.match(/^\d{2}:\d{2}$/)) {
            horaFormato = `${hora}:00`;
        }

        if (!/^\d{2}:\d{2}:\d{2}$/.test(horaFormato)) {
            return res.status(400).json({ error: 'Formato de hora inválido' });
        }

        const fechaObj = new Date(fecha);
        if (isNaN(fechaObj.getTime())) {
            return res.status(400).json({ error: 'Formato de fecha inválido' });
        }

        const parsedAsientos = parseInt(asientosDisponibles, 10);
        const asientosFinales = Number.isFinite(parsedAsientos) && parsedAsientos > 0 ? parsedAsientos : MAX_ASIENTOS_FUNCION;

        if (asientosFinales > MAX_ASIENTOS_FUNCION) {
            return res.status(400).json({ error: `Máximo ${MAX_ASIENTOS_FUNCION} asientos por función` });
        }

        await pool.request()
            .input('id', sql.Int, parseInt(id))
            .input('fecha', sql.Date, fechaObj)
            .input('hora', sql.VarChar, horaFormato)
            .input('precio', sql.Decimal(10, 2), parseFloat(precio))
            .input('asientosDisponibles', sql.Int, asientosFinales)
            .query(`UPDATE Funciones SET fecha = @fecha, hora = CAST(@hora AS TIME), precio = @precio, asientosDisponibles = @asientosDisponibles WHERE id = @id`);
        
        const result = await pool.request()
            .input('id', sql.Int, parseInt(id))
            .query('SELECT * FROM Funciones WHERE id = @id');
        
        res.json(result.recordset[0]);
        
    } catch (err) {
        console.error('❌ Error en PUT funciones:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ====================== BILLETERA VIRTUAL ======================
app.get('/api/billetera/saldo', authMiddleware, async (req, res) => {
    try {
        const result = await pool.request()
            .input('id', sql.Int, req.user.id)
            .query('SELECT saldo FROM Usuarios WHERE id = @id');
        const saldo = parseFloat(result.recordset[0]?.saldo) || 0;
        res.json({ saldo });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/billetera/recargar', authMiddleware, async (req, res) => {
    const monto = parseFloat(req.body?.monto);
    if (!Number.isFinite(monto) || monto <= 0 || monto > 10000) {
        return res.status(400).json({ error: 'Monto inválido (debe ser entre 1 y 10,000)' });
    }

    try {
        await pool.request()
            .input('id', sql.Int, req.user.id)
            .input('monto', sql.Decimal(10, 2), monto)
            .query('UPDATE Usuarios SET saldo = saldo + @monto WHERE id = @id');

        const result = await pool.request()
            .input('id', sql.Int, req.user.id)
            .query('SELECT saldo FROM Usuarios WHERE id = @id');

        const nuevoSaldo = parseFloat(result.recordset[0]?.saldo) || 0;
        res.json({ message: 'Recarga exitosa', saldo: nuevoSaldo });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ====================== COMPRA DE BOLETOS ======================
app.get('/api/funciones/:id/asientos-ocupados', async (req, res) => {
    const funcionId = parseInt(req.params.id, 10);
    if (!Number.isInteger(funcionId)) {
        return res.status(400).json({ error: 'ID de función inválido' });
    }

    try {
        const result = await pool.request()
            .input('funcionId', sql.Int, funcionId)
            .query('SELECT asiento FROM Boletos WHERE funcionId = @funcionId ORDER BY asiento');

        res.json({ funcionId, asientos: result.recordset.map(r => r.asiento) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/funciones/:id/comprar', authMiddleware, async (req, res) => {
    const funcionId = parseInt(req.params.id, 10);
    const usuarioId = req.user?.id;
    const seatsInput = Array.isArray(req.body?.seats) ? req.body.seats : [];
    const useFreeTicket = Boolean(req.body?.useFreeTicket);
    const useSaldo = Boolean(req.body?.useSaldo);

    if (!Number.isInteger(funcionId) || !Number.isInteger(usuarioId)) {
        return res.status(400).json({ error: 'Datos de compra inválidos' });
    }

    const seats = [...new Set(
        seatsInput
            .map(s => String(s || '').trim().toUpperCase())
            .filter(Boolean)
    )];

    if (seats.length === 0) {
        return res.status(400).json({ error: 'Debes seleccionar al menos un asiento' });
    }

    const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const seatsPerRow = 10;
    const seatRegex = /^[A-H](10|[1-9])$/;

    if (!seats.every(s => seatRegex.test(s))) {
        return res.status(400).json({ error: 'Formato de asiento inválido' });
    }

    try {
        const funcionResult = await pool.request()
            .input('id', sql.Int, funcionId)
            .query('SELECT id, asientosDisponibles FROM Funciones WHERE id = @id');

        const funcion = funcionResult.recordset[0];
        if (!funcion) {
            return res.status(404).json({ error: 'Función no encontrada' });
        }

        const asientosHabilitados = Math.max(0, Math.min(MAX_ASIENTOS_FUNCION, funcion.asientosDisponibles));

        const fueraDeAforo = seats.filter(seat => {
            const row = seat.charAt(0);
            const col = parseInt(seat.slice(1), 10);
            const seatIndex = rows.indexOf(row) * seatsPerRow + (col - 1);
            return seatIndex >= asientosHabilitados;
        });

        if (fueraDeAforo.length > 0) {
            return res.status(400).json({
                error: `Asientos fuera del aforo habilitado: ${fueraDeAforo.join(', ')}`
            });
        }

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const userResult = await new sql.Request(transaction)
                .input('usuarioId', sql.Int, usuarioId)
                .query('SELECT id, puntos, saldo FROM Usuarios WHERE id = @usuarioId');

            const user = userResult.recordset[0];
            if (!user) {
                await transaction.rollback();
                return res.status(404).json({ error: 'Usuario no encontrado' });
            }

            const puntosActuales = Number.isFinite(user.puntos) ? user.puntos : 0;
            const saldoActual = parseFloat(user.saldo) || 0;
            const freeTicketApplied = useFreeTicket && seats.length >= 1;

            if (freeTicketApplied && puntosActuales < PUNTOS_ENTRADA_GRATIS) {
                await transaction.rollback();
                return res.status(400).json({ error: `Necesitas ${PUNTOS_ENTRADA_GRATIS} puntos para una entrada gratis` });
            }

            // La compra siempre se cobra del saldo virtual
            const entradasPagadas = Math.max(0, seats.length - (freeTicketApplied ? 1 : 0));
            const funcionResult2 = await new sql.Request(transaction)
                .input('id', sql.Int, funcionId)
                .query('SELECT precio FROM Funciones WHERE id = @id');
            const precio = parseFloat(funcionResult2.recordset[0]?.precio) || 0;
            const totalCosto = entradasPagadas * precio;

            if (saldoActual < totalCosto) {
                await transaction.rollback();
                return res.status(400).json({
                    error: `Saldo insuficiente. Necesitas $${totalCosto.toFixed(2)} pero tienes $${saldoActual.toFixed(2)}. Recarga en Mi Billetera.`
                });
            }

            if (totalCosto > 0) {
                await new sql.Request(transaction)
                    .input('usuarioId', sql.Int, usuarioId)
                    .input('costo', sql.Decimal(10, 2), totalCosto)
                    .query('UPDATE Usuarios SET saldo = saldo - @costo WHERE id = @usuarioId');
            }

            const checkReq = new sql.Request(transaction)
                .input('funcionId', sql.Int, funcionId);

            const seatParams = seats.map((seat, i) => {
                const key = `s${i}`;
                checkReq.input(key, sql.NVarChar, seat);
                return `@${key}`;
            }).join(',');

            const ocupadosResult = await checkReq.query(`
                SELECT asiento
                FROM Boletos
                WHERE funcionId = @funcionId
                AND asiento IN (${seatParams})
            `);

            if (ocupadosResult.recordset.length > 0) {
                await transaction.rollback();
                return res.status(409).json({
                    error: 'Algunos asientos ya fueron comprados',
                    ocupados: ocupadosResult.recordset.map(r => r.asiento)
                });
            }

            const boletosGenerados = [];
            for (const seat of seats) {
                const inserted = await new sql.Request(transaction)
                    .input('funcionId', sql.Int, funcionId)
                    .input('usuarioId', sql.Int, usuarioId)
                    .input('asiento', sql.NVarChar, seat)
                    .query(`
                        INSERT INTO Boletos (funcionId, usuarioId, asiento, fechaCompra)
                        OUTPUT INSERTED.id, INSERTED.asiento, INSERTED.fechaCompra
                        VALUES (@funcionId, @usuarioId, @asiento, GETDATE())
                    `);

                if (inserted.recordset[0]) {
                    boletosGenerados.push(inserted.recordset[0]);
                }
            }

            const puntosGanados = entradasPagadas * PUNTOS_POR_ENTRADA;
            const puntosGastados = freeTicketApplied ? PUNTOS_ENTRADA_GRATIS : 0;
            const puntosFinales = puntosActuales - puntosGastados + puntosGanados;

            await new sql.Request(transaction)
                .input('usuarioId', sql.Int, usuarioId)
                .input('puntos', sql.Int, puntosFinales)
                .query('UPDATE Usuarios SET puntos = @puntos WHERE id = @usuarioId');

            // Obtener saldo actualizado
            const saldoResult = await new sql.Request(transaction)
                .input('usuarioId', sql.Int, usuarioId)
                .query('SELECT saldo FROM Usuarios WHERE id = @usuarioId');
            const saldoFinal = parseFloat(saldoResult.recordset[0]?.saldo) || 0;

            const funcionDetalleResult = await new sql.Request(transaction)
                .input('funcionId', sql.Int, funcionId)
                .query(`
                    SELECT
                        p.Titulo AS pelicula,
                        CONVERT(VARCHAR(10), f.fecha, 23) AS fecha,
                        CONVERT(VARCHAR(5), f.hora, 108) AS hora,
                        s.nombre AS sala,
                        CAST(f.precio AS DECIMAL(10,2)) AS precio
                    FROM Funciones f
                    INNER JOIN Peliculas p ON f.peliculaId = p.id
                    INNER JOIN Salas s ON f.salaId = s.id
                    WHERE f.id = @funcionId
                `);

            const funcionDetalle = funcionDetalleResult.recordset[0] || {};
            const folioBase = boletosGenerados.length > 0
                ? `CN-${boletosGenerados[0].id}-${usuarioId}`
                : `CN-${Date.now()}-${usuarioId}`;

            const comprobante = {
                folio: folioBase,
                titular: req.user?.nombre || req.user?.email || 'Cliente',
                usuarioEmail: req.user?.email || null,
                fechaEmision: new Date().toISOString(),
                funcion: {
                    pelicula: funcionDetalle.pelicula || null,
                    fecha: funcionDetalle.fecha || null,
                    hora: funcionDetalle.hora || null,
                    sala: funcionDetalle.sala || null,
                    precioUnitario: Number(funcionDetalle.precio || 0)
                },
                boletos: boletosGenerados.map((b) => ({
                    boletoId: Number(b.id),
                    asiento: b.asiento,
                    fechaCompra: b.fechaCompra,
                    folioBoleto: `${folioBase}-${b.id}`
                })),
                totalBoletos: seats.length,
                totalCobrado: Number(totalCosto || 0),
                entradaGratisAplicada: freeTicketApplied
            };

            await transaction.commit();
            return res.status(201).json({
                message: 'Compra realizada correctamente',
                seats,
                puntosGanados,
                puntosGastados,
                puntosActuales: puntosFinales,
                entradaGratisAplicada: freeTicketApplied,
                saldoActual: saldoFinal,
                pagadoConSaldo: true,
                comprobante
            });
        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }
    } catch (err) {
        console.error('❌ Error al comprar asientos:', err.message);
        return res.status(500).json({ error: 'Error interno al procesar la compra' });
    }
});

// ====================== REPORTES DE VENTAS ======================
app.get('/api/reportes/ventas', authMiddleware, async (req, res) => {
    const { desde, hasta } = req.query;

    if (!['administrador', 'consultor', 'editor'].includes(req.user?.rol)) {
        return res.status(403).json({ error: 'Solo el administrador, consultor y editor pueden consultar este reporte' });
    }

    try {
        const request = pool.request();
        let whereClause = '';

        if (desde && hasta) {
            whereClause = 'WHERE CONVERT(date, b.fechaCompra) BETWEEN @desde AND @hasta';
            request.input('desde', sql.Date, desde);
            request.input('hasta', sql.Date, hasta);
        } else if (desde) {
            whereClause = 'WHERE CONVERT(date, b.fechaCompra) >= @desde';
            request.input('desde', sql.Date, desde);
        } else if (hasta) {
            whereClause = 'WHERE CONVERT(date, b.fechaCompra) <= @hasta';
            request.input('hasta', sql.Date, hasta);
        }

        const resumenResult = await request.query(`
            SELECT
                COUNT(*) AS boletosVendidos,
                ISNULL(SUM(CAST(f.precio AS DECIMAL(10,2))), 0) AS ingresosTotales,
                ISNULL(AVG(CAST(f.precio AS DECIMAL(10,2))), 0) AS precioPromedio
            FROM Boletos b
            INNER JOIN Funciones f ON b.funcionId = f.id
            ${whereClause}
        `);

        const porPeliculaRequest = pool.request();
        if (desde && hasta) {
            porPeliculaRequest.input('desde', sql.Date, desde);
            porPeliculaRequest.input('hasta', sql.Date, hasta);
        } else if (desde) {
            porPeliculaRequest.input('desde', sql.Date, desde);
        } else if (hasta) {
            porPeliculaRequest.input('hasta', sql.Date, hasta);
        }

        const porPeliculaResult = await porPeliculaRequest.query(`
            SELECT
                p.Titulo AS pelicula,
                COUNT(*) AS boletosVendidos,
                ISNULL(SUM(CAST(f.precio AS DECIMAL(10,2))), 0) AS ingresos
            FROM Boletos b
            INNER JOIN Funciones f ON b.funcionId = f.id
            INNER JOIN Peliculas p ON f.peliculaId = p.id
            ${whereClause}
            GROUP BY p.Titulo
            ORDER BY boletosVendidos DESC, pelicula ASC
        `);

        const porFuncionRequest = pool.request();
        if (desde && hasta) {
            porFuncionRequest.input('desde', sql.Date, desde);
            porFuncionRequest.input('hasta', sql.Date, hasta);
        } else if (desde) {
            porFuncionRequest.input('desde', sql.Date, desde);
        } else if (hasta) {
            porFuncionRequest.input('hasta', sql.Date, hasta);
        }

        const porFuncionResult = await porFuncionRequest.query(`
            SELECT
                p.Titulo AS pelicula,
                CONVERT(VARCHAR(10), f.fecha, 23) AS fecha,
                CONVERT(VARCHAR(5), f.hora, 108) AS hora,
                COUNT(*) AS boletosVendidos,
                ISNULL(SUM(CAST(f.precio AS DECIMAL(10,2))), 0) AS ingresos
            FROM Boletos b
            INNER JOIN Funciones f ON b.funcionId = f.id
            INNER JOIN Peliculas p ON f.peliculaId = p.id
            ${whereClause}
            GROUP BY p.Titulo, f.fecha, f.hora
            ORDER BY f.fecha DESC, f.hora DESC
        `);

        const resumen = resumenResult.recordset[0] || {
            boletosVendidos: 0,
            ingresosTotales: 0,
            precioPromedio: 0
        };

        return res.json({
            filtros: { desde: desde || null, hasta: hasta || null },
            resumen: {
                boletosVendidos: Number(resumen.boletosVendidos || 0),
                ingresosTotales: Number(resumen.ingresosTotales || 0),
                precioPromedio: Number(resumen.precioPromedio || 0)
            },
            porPelicula: porPeliculaResult.recordset.map((r) => ({
                pelicula: r.pelicula,
                boletosVendidos: Number(r.boletosVendidos || 0),
                ingresos: Number(r.ingresos || 0)
            })),
            porFuncion: porFuncionResult.recordset.map((r) => ({
                pelicula: r.pelicula,
                fecha: r.fecha,
                hora: r.hora,
                boletosVendidos: Number(r.boletosVendidos || 0),
                ingresos: Number(r.ingresos || 0)
            }))
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ====================== INICIALIZAR ======================
async function start() {
    await initDB();
    app.listen(PORT, () => {
        console.log(`✅ Servidor Cineteca corriendo en puerto ${PORT}`);
    });
}

start();