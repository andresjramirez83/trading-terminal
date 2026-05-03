# Trading Terminal Sprint 1

This is the Sprint 1 foundation for your long-term trading terminal.

## Stack
- Frontend: React + TypeScript + Vite + Lightweight Charts
- Backend: FastAPI
- Data: Polygon

## Requirements
- VS Code
- Node.js 20.19+ or 22.12+ (required by current Vite) 
- Python 3.11+

## Backend setup
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# edit .env and add your real POLYGON_API_KEY
uvicorn app.main:app --reload --port 8000
```

## Frontend setup
Open a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Frontend: http://localhost:5173
Backend: http://localhost:8000
Health: http://localhost:8000/health

## What Sprint 1 includes
- AAPL default symbol
- 1m / 5m / 15m selector
- Candles + volume
- Last price label
- Backend-owned market data flow

## Next sprint
- WebSocket live updates
- stable partial candle updates
- no full reload for each refresh
