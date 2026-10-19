export type ErrorCode =
  | 'mic-denied'
  | 'mic-missing'
  | 'mic-busy'
  | 'mic-insecure'
  | 'mic-unsupported'
  | 'mic-disconnected'
  | 'mic-unknown'
  | 'audio-unsupported'
  | 'file-invalid'
  | 'file-unsupported'
  | 'file-unreadable'
  | 'storage-unavailable'
  | 'storage-full'
  | 'player-failed'
  | 'module-failed';

const MESSAGES: Record<ErrorCode, string> = {
  'mic-denied':
    "Accès au micro refusé. Autorisez le micro pour ce site dans les réglages du navigateur (sur iPhone : Réglages › Safari › Micro), puis touchez « Démarrer ».",
  'mic-missing': 'Aucun micro détecté. Branchez ou activez un micro, puis touchez « Démarrer ».',
  'mic-busy': 'Le micro est déjà utilisé par une autre application. Fermez-la, puis touchez « Démarrer ».',
  'mic-insecure':
    "Le micro n'est accessible que sur une adresse sécurisée (https:// ou localhost). Ouvrez l'app depuis une adresse https://.",
  'mic-unsupported': "Ce navigateur ne permet pas d'utiliser le micro. Essayez Safari, Chrome, Edge ou Firefox récents.",
  'mic-disconnected': "Le micro s'est déconnecté. Vérifiez-le, puis touchez « Démarrer ».",
  'mic-unknown': "Impossible d'ouvrir le micro. Touchez « Démarrer » pour réessayer.",
  'audio-unsupported': "Ce navigateur ne prend pas en charge l'audio Web. Essayez Safari, Chrome, Edge ou Firefox récents.",
  'file-invalid': 'Fichier invalide : son contenu ne correspond pas à son format. Il est peut-être corrompu ou mal nommé.',
  'file-unsupported':
    'Format non pris en charge. Formats acceptés : Guitar Pro (.gp, .gp3, .gp4, .gp5, .gpx), MusicXML (.musicxml, .mxl) et MIDI (.mid).',
  'file-unreadable': 'Impossible de lire ce fichier. Réessayez ou choisissez un autre fichier.',
  'storage-unavailable':
    "La bibliothèque n'est pas disponible dans ce navigateur (navigation privée ?). La partition s'ouvre, mais ne sera pas conservée.",
  'storage-full': "Plus de place pour enregistrer cette partition. Supprimez-en d'autres de la bibliothèque, puis réimportez-la.",
  'module-failed': "Le module Partitions n'a pas pu être chargé. Vérifiez la connexion, puis réessayez.",
  'player-failed': "Le lecteur audio n'a pas pu démarrer. Rechargez la page, puis touchez « Lire ».",
};

/** Erreur applicative portant un message en français prêt à afficher. */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string = MESSAGES[code]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export function messageFor(code: ErrorCode): string {
  return MESSAGES[code];
}

/** Traduit une erreur de getUserMedia en erreur applicative lisible. */
export function microphoneError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new AppError('mic-denied');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new AppError('mic-missing');
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new AppError('mic-busy');
    case 'NotSupportedError':
    case 'TypeError':
      return new AppError('mic-unsupported');
    default:
      return new AppError('mic-unknown');
  }
}

/** Message à afficher pour n'importe quelle erreur. Les erreurs inattendues sont journalisées. */
export function describeError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  console.error(error);
  return "Une erreur inattendue s'est produite. Rechargez la page et réessayez.";
}
