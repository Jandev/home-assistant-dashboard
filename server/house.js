// Dashboard-only presentation; no Home Assistant registry changes.
export function houseRooms(ha, config) {
  const house = config.house || {}, excluded = new Set(house.excludeEntities || []);
  return ha.rooms().filter(r => !(house.excludeRooms || []).includes(r.id)).map(room => {
    let entities = [...new Set([...room.entities, ...(house.roomEntities?.[room.id] || [])])].filter(id => !excluded.has(id));
    for (const group of house.lightGroups || []) {
      if (group.room !== room.id) continue;
      entities = entities.filter(id => !group.entities.includes(id));
      entities.unshift(group.id);
    }
    return { ...room, entities };
  }).filter(r => r.entities.length);
}
export function houseState(ha, config, id) {
  const group = config.house?.lightGroups?.find(g => g.id === id);
  if (!group) return ha.states.get(id);
  const members = group.entities.map(member => ha.states.get(member));
  const available = members.length > 0 && members.every(s => s && !['unknown', 'unavailable'].includes(s.state));
  const on = members.find(s => s?.state === 'on');
  const source = on || members.find(Boolean);
  return { entity_id: id, state: available ? on ? 'on' : 'off' : 'unavailable', last_updated: source?.last_updated,
    attributes: { ...source?.attributes, friendly_name: group.name,
      supported_color_modes: members.every(s => s?.attributes.supported_color_modes?.some(m => ['xy', 'hs', 'rgb', 'rgbw', 'rgbww'].includes(m))) ? ['rgb'] : ['brightness'] } };
}
