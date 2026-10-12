const express = require('express');
const turf = require('@turf/turf');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Armazenamento em memória (em produção, utilize PostgreSQL/PostGIS ou MongoDB)
const sessions = {};
let activeZone = null;

/**
 * POST /api/zone
 * Configura o polígono da via/área permitida e a meta de quilometragem.
 */
app.post('/api/zone', (req, res) => {
  const { coordinates, targetKm, zoneName } = req.body;

  if (!coordinates || coordinates.length < 4) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'O polígono precisa de pelo menos 4 coordenadas fechadas [lng, lat].' 
    });
  }

  try {
    const polygon = turf.polygon([coordinates]);
    activeZone = { 
      name: zoneName || 'Zona de Circulação Obrigatória', 
      polygon, 
      targetKm: targetKm || 10.0 
    };

    return res.json({ 
      status: 'success', 
      message: 'Zona delimitada configurada com sucesso.', 
      zone: activeZone.name, 
      targetKm: activeZone.targetKm 
    });
  } catch (error) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Polígono GeoJSON inválido.', 
      details: error.message 
    });
  }
});

/**
 * POST /api/location
 * Recebe a atualização de GPS do aplicativo Android.
 */
app.post('/api/location', (req, res) => {
  const { userId, latitude, longitude, timestamp } = req.body;

  if (!activeZone) {
    return res.status(400).json({ 
      status: 'error', 
      message: 'Nenhuma área/zona definida no servidor.' 
    });
  }

  if (!sessions[userId]) {
    sessions[userId] = { 
      lastPoint: null, 
      accumulatedDistanceKm: 0.0, 
      isGoalReached: false, 
      isInsideZone: true 
    };
  }

  const userSession = sessions[userId];
  const currentPoint = turf.point([longitude, latitude]);

  // Checa se a coordenada do veículo está dentro da área
  const isInside = turf.booleanPointInPolygon(currentPoint, activeZone.polygon);
  userSession.isInsideZone = isInside;

  let distanceAdded = 0;

  if (isInside) {
    if (userSession.lastPoint) {
      const prevPoint = turf.point(userSession.lastPoint);
      // Calcula distância Haversine em KM
      distanceAdded = turf.distance(prevPoint, currentPoint, { units: 'kilometers' });

      // Filtra ruídos micro-deslocamentos de GPS (menos de 5 metros)
      if (distanceAdded >= 0.005) {
        userSession.accumulatedDistanceKm += distanceAdded;
      }
    }
    userSession.lastPoint = [longitude, latitude];

    if (userSession.accumulatedDistanceKm >= activeZone.targetKm) {
      userSession.isGoalReached = true;
    }
  } else {
    // Reseta o ponto anterior para não somar pulos caso o veículo saia e reentre
    userSession.lastPoint = null;
  }

  return res.json({ 
    status: 'ok', 
    userId, 
    isInsideZone: userSession.isInsideZone, 
    distanceAddedKm: parseFloat(distanceAdded.toFixed(4)), 
    accumulatedDistanceKm: parseFloat(userSession.accumulatedDistanceKm.toFixed(3)), 
    targetKm: activeZone.targetKm, 
    isGoalReached: userSession.isGoalReached, 
    warning: !userSession.isInsideZone ? 'ALERTA: Veículo fora da área permitida!' : null 
  });
});

/**
 * GET /api/status/:userId
 * Retorna o progresso atual do motorista.
 */
app.get('/api/status/:userId', (req, res) => {
  const session = sessions[req.params.userId];
  if (!session) {
    return res.status(404).json({ status: 'error', message: 'Sessão não encontrada.' });
  }
  return res.json({ userId: req.params.userId, ...session });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor de Validação de Rota rodando na porta ${PORT}`);
});
