// OWNER: auth-flow — static privacy page (GDPR-shaped honest draft, clearly marked
// as BOZZA). Copy lives in i18n (legal.privacy_title/body, pending merge); the body
// uses "## " paragraph prefixes as section headings.
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, severityTint, spacing, radius, type as typeScale } from '../../theme';

const PRIVACY_BODY_IT = `## Chi siamo
Arvo è un'app per seguire i tuoi campi con dati satellitari, meteo e rilievi. Questa informativa spiega quali dati trattiamo e quali diritti hai secondo il GDPR (Regolamento UE 2016/679).

## Quali dati raccogliamo
— Account: nome, email, nome dell'azienda agricola e lingua.
— Campi: confini, colture e superfici che disegni o importi dal catasto.
— Rilievi e foto: le note e le immagini che registri sul campo.
— Posizione: solo quando la usi, per agganciare un rilievo al punto giusto del campo. Puoi negarla quando vuoi.
— Dati tecnici minimi, necessari a far funzionare e proteggere il servizio.

## Perché li usiamo
Solo per il servizio: mostrarti i campi, calcolare gli indicatori, mandarti gli avvisi che scegli. Base giuridica: il contratto con te (art. 6.1.b GDPR); per le notifiche facoltative, il tuo consenso.

## Dove stanno i dati
Su server nell'Unione Europea.

## Con chi li condividiamo
Non vendiamo i tuoi dati e non li cediamo per pubblicità. Li vedono solo le persone della tua azienda che inviti e i fornitori tecnici indispensabili (hosting, invio notifiche), vincolati da contratto.

## Per quanto li teniamo
Finché il tuo account è attivo. Se lo elimini, cancelliamo i dati entro 30 giorni, salvo obblighi di legge.

## I tuoi diritti
Puoi chiedere quando vuoi la copia dei tuoi dati (esportazione), la correzione, la cancellazione o la limitazione del trattamento, e puoi fare reclamo al Garante. Scrivici dalla pagina Aiuto e contatti: rispondiamo senza costi.`;

export default function PrivacyScreen() {
  const { t } = useTranslation();
  const body = t('legal.privacy_body', { defaultValue: PRIVACY_BODY_IT });
  return (
    <>
      <Stack.Screen
        options={{ title: t('legal.privacy_title', { defaultValue: 'Informativa sulla privacy' }) }}
      />
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        <View style={styles.draft}>
          <Text style={styles.draftText} maxFontSizeMultiplier={typeScale.maxMult}>
            {t('legal.draft_notice', { defaultValue: 'BOZZA — da far revisionare legalmente' })}
          </Text>
        </View>
        <Text
          style={styles.title}
          accessibilityRole="header"
          maxFontSizeMultiplier={typeScale.maxMult}
        >
          {t('legal.privacy_title', { defaultValue: 'Informativa sulla privacy' })}
        </Text>
        {body.split('\n\n').map((para, i) =>
          para.startsWith('## ') ? (
            <Text
              key={i}
              style={styles.heading}
              accessibilityRole="header"
              maxFontSizeMultiplier={typeScale.maxMult}
            >
              {para.slice(3)}
            </Text>
          ) : (
            <Text key={i} style={styles.para} maxFontSizeMultiplier={typeScale.maxMult}>
              {para}
            </Text>
          ),
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xl, maxWidth: 640, width: '100%', alignSelf: 'center' },
  draft: {
    alignSelf: 'flex-start',
    backgroundColor: severityTint.warning.bg,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginBottom: spacing.md,
  },
  draftText: {
    color: severityTint.warning.fg,
    fontSize: typeScale.caption,
    fontFamily: fonts.bodyBold,
  },
  title: {
    fontSize: typeScale.titleLg,
    fontFamily: fonts.display,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  heading: {
    fontSize: typeScale.title,
    fontFamily: fonts.display,
    color: colors.text,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
  },
  para: {
    fontSize: typeScale.body,
    fontFamily: fonts.body,
    color: colors.textMuted,
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
});
