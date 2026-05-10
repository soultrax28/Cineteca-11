CREATE DATABASE CinetecaDB;
GO
USE CinetecaDB;
GO

-- 2. Tabla de Películas
CREATE TABLE Peliculas (
    id INT IDENTITY(1,1) PRIMARY KEY,
    Titulo NVARCHAR(200) NOT NULL,
    Genero NVARCHAR(100),
    Duracion INT,
    imagen_url NVARCHAR(255) DEFAULT '/imagenes/default.jpg'
);

-- 3. Tabla de Salas
CREATE TABLE Salas (
    id INT IDENTITY(1,1) PRIMARY KEY,
    nombre NVARCHAR(100) NOT NULL,
    capacidad INT NOT NULL,
    tecnologia NVARCHAR(200),
    estado NVARCHAR(20) DEFAULT 'activa'
);

-- 4. Tabla de Funciones
CREATE TABLE Funciones (
    id INT IDENTITY(1,1) PRIMARY KEY,
    peliculaId INT NOT NULL,
    salaId INT NOT NULL,
    fecha DATE NOT NULL,
    hora TIME NOT NULL,
    precio DECIMAL(10, 2) DEFAULT 15.00,
    asientosDisponibles INT DEFAULT 100,

    -- Llaves Foráneas
    CONSTRAINT FK_Funciones_Peliculas FOREIGN KEY (peliculaId) REFERENCES Peliculas(id) ON DELETE CASCADE,
    CONSTRAINT FK_Funciones_Salas FOREIGN KEY (salaId) REFERENCES Salas(id) ON DELETE CASCADE
);

-- 5. Tabla de Usuarios
CREATE TABLE Usuarios (
    id INT IDENTITY(1,1) PRIMARY KEY,
    nombre NVARCHAR(100),
    email NVARCHAR(150) UNIQUE NOT NULL,
    password NVARCHAR(255) NOT NULL,
    rol NVARCHAR(20) DEFAULT 'consultor',
    saldo DECIMAL(10, 2) DEFAULT 0.00,
    puntos INT DEFAULT 0
);

-- 6. Tabla de Boletos
CREATE TABLE Boletos (
    id INT IDENTITY(1,1) PRIMARY KEY,
    funcionId INT NOT NULL,
    usuarioId INT NOT NULL,
    asiento NVARCHAR(10) NOT NULL,
    estado NVARCHAR(20) DEFAULT 'vendido',
    fechaCompra DATETIME2(7) DEFAULT GETDATE(),

    -- Llaves Foráneas
    CONSTRAINT FK_Boletos_Funciones FOREIGN KEY (funcionId) REFERENCES Funciones(id) ON DELETE CASCADE
    -- Nota: Podrías agregar una FK para usuarioId aquí si lo deseas
);