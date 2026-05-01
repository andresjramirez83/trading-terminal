from app.scanners.overnight_runner import OvernightRunnerScanner


class ScannerRegistry:
    def __init__(self):
        scanners = [
            OvernightRunnerScanner(),
        ]
        self.scanners = {scanner.id: scanner for scanner in scanners}

    def get(self, scanner_id: str):
        return self.scanners.get(scanner_id)

    def list(self):
        return [
            {
                "id": s.id,
                "name": s.name,
                "description": s.description,
            }
            for s in self.scanners.values()
        ]
