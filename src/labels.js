// Place labels for Customs. Base set from tarkov.dev maps.json; detail labels (dorms 2/3-story, bunkers, etc.)
// derived from tarkov.dev's SVG building groups and layer extents. position = x, z game coords; size = % (default 100).
export const CUSTOMS_LABELS = [
  {
    "position": [
      -215,
      -119
    ],
    "text": "Big Red"
  },
  {
    "position": [
      404,
      31
    ],
    "text": "New Gas"
  },
  {
    "position": [
      331,
      -173
    ],
    "text": "Old Gas"
  },
  {
    "position": [
      201,
      -127
    ],
    "text": "Fortress"
  },
  {
    "position": [
      83,
      -153
    ],
    "text": "Crackhouse"
  },
  {
    "position": [
      567,
      -67
    ],
    "text": "Streamer House",
    "size": 90
  },
  {
    "position": [
      -69,
      9
    ],
    "text": "Main Bridge",
    "rotation": "6",
    "size": 90
  },
  {
    "position": [
      110,
      85
    ],
    "text": "Sniper Hill",
    "size": 90
  },
  {
    "position": [
      -288,
      -134
    ],
    "text": "Storage",
    "size": 90
  },
  {
    "position": [
      -211,
      -219
    ],
    "text": "Trailer Park",
    "size": 90
  },
  {
    "position": [
      -66,
      46
    ],
    "text": "Junk Bridge",
    "size": 90
  },
  {
    "position": [
      106,
      -90
    ],
    "text": "Repair Shop",
    "size": 90
  },
  {
    "position": [
      491,
      63
    ],
    "text": "Sniper Ridge",
    "rotation": "5"
  },
  {
    "position": [
      75,
      -9
    ],
    "text": "Old Construction",
    "size": 90
  },
  {
    "position": [
      200,
      -13
    ],
    "text": "Skeleton",
    "rotation": "-9"
  },
  {
    "position": [
      390,
      -94
    ],
    "text": "Warehouse 3"
  },
  {
    "position": [
      472,
      -67
    ],
    "text": "Depot"
  },
  {
    "position": [
      555,
      -118
    ],
    "text": "Warehouse 7"
  },
  {
    "position": [
      572,
      0
    ],
    "text": "Military Checkpoint"
  },
  {
    "position": [
      238,
      53
    ],
    "text": "Bus Station",
    "size": 90
  },
  {
    "position": [
      333,
      -67
    ],
    "text": "Warehouse 4"
  },
  {
    "position": [
      497,
      110
    ],
    "text": "Powerline Tower"
  },
  {
    "position": [
      46,
      -59
    ],
    "text": "Warehouse 17",
    "size": 90
  },
  {
    "position": [
      231,
      150
    ],
    "text": "Dorms 2-Story",
    "size": 90
  },
  {
    "position": [
      183,
      167
    ],
    "text": "Dorms 3-Story",
    "size": 90
  },
  {
    "position": [
      612,
      -130
    ],
    "text": "Water Pump",
    "size": 85
  },
  {
    "position": [
      628,
      -131
    ],
    "text": "ZB-1011",
    "size": 80
  },
  {
    "position": [
      466,
      -116
    ],
    "text": "ZB-1012",
    "size": 80
  },
  {
    "position": [
      206,
      -148
    ],
    "text": "ZB-013",
    "size": 80
  },
  {
    "position": [
      110,
      -50
    ],
    "text": "Boiler",
    "size": 80
  },
  {
    "position": [
      262,
      -40
    ],
    "text": "Oil Rig",
    "size": 85
  },
  {
    "position": [
      183,
      -276
    ],
    "text": "Scav Sniper",
    "size": 85
  }
];

// Base sets mirrored from tarkov.dev maps.json. Detail labels are added during each map pass.
export const RESERVE_LABELS = [
  // Chess-piece names and positions mirror tarkov.dev. Combined aliases avoid
  // duplicate labels over the same landmark while retaining the common callout.
  { position: [-15, 182], text: 'White Queen / Dome', rotation: -15, bottom: -6 },
  { position: [-104, 93], text: 'White Pawn', rotation: 14, bottom: -6 },
  { position: [-140, -14.5], text: 'Black Bishop', rotation: 14, bottom: -6 },
  { position: [-67, -30], text: 'White Bishop', rotation: 14, bottom: -6 },
  { position: [-49.5, 15.5], text: 'White King', rotation: 14, bottom: -6 },
  { position: [14.5, -10.8], text: 'Black Knight', bottom: -6 },
  { position: [82.2, -30.2], text: 'White Knight', bottom: -6 },
  { position: [158, -145], text: 'White Rook / Train Station', rotation: 14, bottom: -6 },
  { position: [-173, 70], text: 'Black Pawn', bottom: -6 },
  { position: [-127, 39], text: 'Helipad / Helicopter', bottom: -6 },
  { position: [174, -224], text: 'Military Guard Barracks', bottom: -6 },
  { position: [48, -184], text: 'Bunker Hermetic Door', floor: 'both', bottom: -6 },
  { position: [141, 25], text: 'Depot Hermetic Door', floor: 'both', bottom: -6 },
  { position: [96, 30], text: 'Garage', rotation: -75, size: 80, bottom: -6 },
  { position: [55.5, 60.6], text: 'Mechanic', size: 80, bottom: -6 },
  { position: [29.7, 29.5], text: 'Gas Station', rotation: 14, size: 80, bottom: -6 },
  { position: [-31, -150], text: 'Shipping Yard', rotation: 14, size: 80, bottom: -6 },
  { position: [-1, -71], text: 'Storage K1', rotation: 14, size: 75, bottom: -6 },
  { position: [66, -90], text: 'Storage K2', rotation: 14, size: 75, bottom: -6 },
  { position: [-5.5, -94], text: 'Storage K3', rotation: 14, size: 75, bottom: -6 },
  { position: [60, -112], text: 'Storage K4', rotation: 14, size: 75, bottom: -6 },
  { position: [-10.5, -115], text: 'Storage K5', rotation: 14, size: 75, bottom: -6 },
  { position: [54, -132], text: 'Storage K6', rotation: 14, size: 75, bottom: -6 },

  // Underground-only navigation. The U floor hides surface place labels and
  // promotes this compact connection graph instead.
  { position: [-82, 157], text: 'D-2', floor: 'U', bottom: -6 },
  { position: [-111, 44], text: 'Command Bunker', floor: 'U', bottom: -6 },
  { position: [73, -119], text: 'Storage Bunker Tunnels', floor: 'U', bottom: -6 },
  { position: [-23, 181], text: 'Dome Tunnels', floor: 'U', size: 80, bottom: -6 },
  { position: [-104, 76], text: 'White Pawn Hermetic', floor: 'U', size: 75, bottom: -6 },
  { position: [-155, 43], text: 'Black Pawn Hermetic', floor: 'U', size: 75, bottom: -6 },
  { position: [-67, -18], text: 'White Bishop Hermetic', floor: 'U', size: 75, bottom: -6 },
  { position: [-137, -3], text: 'Black Bishop Hermetic', floor: 'U', size: 75, bottom: -6 },
  { position: [-49, 16], text: 'King Hermetic', floor: 'U', size: 75, bottom: -6 },
];

export const WOODS_LABELS = [
  { position: [10, -3], text: 'Sawmill' },
  { position: [-485, -390], text: 'Scav Town' },
  { position: [-517, -210], text: 'Old Sawmill' },
  { position: [-80, -680], text: 'Sunken Village / Abandoned Village' },
  { position: [290, -475], text: 'USEC CAMP' },
  { position: [-188, 235], text: 'Military Camp' },
  { position: [412, 240], text: 'Scav House' },
  { position: [-505, -530], text: 'Bridge V-Ex' },
  { position: [74, -876], text: 'Friendship / Scav Bridge' },
  { position: [-700, 118], text: 'Railway Bridge to Tarkov' },
  { position: [-5, -515], text: 'Ponds', size: 80 },
  { position: [-252, -37], text: 'Crash Site', size: 80 },
  { position: [239, -65], text: 'Checkpoint', size: 70 },
  { position: [244, 125], text: 'Shack', size: 70 },
  { position: [-16, -122], text: 'Lumber', size: 70 },
  { position: [-3, -74], text: 'Cabins', size: 70 },
  { position: [-234, 357], text: 'Bus Stop', size: 70 },
  { position: [-327, 19], text: "Jaeger's Camp", size: 70 },
  { position: [85, -147], text: 'Sniper Rock' },
  { position: [-198, -231], text: 'Mountain Spine' },
  { position: [200, -606], text: 'Convoy', size: 70 },
];

export const LABELS = {
  customs: CUSTOMS_LABELS,
  reserve: RESERVE_LABELS,
  woods: WOODS_LABELS,
};
