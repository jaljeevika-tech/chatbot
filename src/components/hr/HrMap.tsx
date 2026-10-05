// Lazy-loaded Leaflet map of check-in/out locations. Same keyless Esri tiles as
// BeneficiaryRegistrationDashboardPage; tiles need a connection, coordinates don't.

import { useEffect } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { FF } from '../../theme/colors'

export interface MapPoint {
  key: string
  lat: number
  lng: number
  color: string
  title: string
  detail?: string
}

function FitBounds({ points }: { points: MapPoint[] }) {
  const map = useMap()
  useEffect(() => {
    if (points.length === 1) map.setView([points[0].lat, points[0].lng], 14)
    else if (points.length > 1) map.fitBounds(points.map(p => [p.lat, p.lng] as [number, number]), { padding: [30, 30], maxZoom: 15 })
  }, [map, points])
  return null
}

export default function HrMap({ points, height = 320 }: { points: MapPoint[]; height?: number }) {
  if (!navigator.onLine) {
    return (
      <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
        color: FF.textMuted, background: FF.bg, borderRadius: 10, textAlign: 'center', padding: 12 }}>
        The map needs an internet connection. Locations are still recorded and listed below.
      </div>
    )
  }
  if (!points.length) {
    return <div style={{ fontSize: 13, color: FF.textFaint, padding: '8px 0' }}>No locations recorded for this period.</div>
  }
  return (
    <div style={{ height, borderRadius: 10, overflow: 'hidden', border: `1px solid ${FF.border}` }}>
      <MapContainer center={[points[0].lat, points[0].lng]} zoom={12} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false}>
        <TileLayer
          attribution='Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Sources: Esri, HERE, Garmin, USGS, OpenStreetMap contributors, and the GIS User Community'
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"
          maxZoom={18}
        />
        <FitBounds points={points} />
        {points.map(p => (
          <CircleMarker key={p.key} center={[p.lat, p.lng]} radius={8}
            pathOptions={{ color: '#FFFFFF', weight: 2, fillColor: p.color, fillOpacity: 0.9 }}>
            <Tooltip>
              <div style={{ fontWeight: 600 }}>{p.title}</div>
              {p.detail && <div>{p.detail}</div>}
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  )
}
