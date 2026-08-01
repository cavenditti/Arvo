// OWNER: auth-flow — static terms page (honest plain-language draft, clearly marked
// as BOZZA). Copy lives in i18n (legal.terms_title/body, pending merge); the body
// uses "## " paragraph prefixes as section headings.
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, severityTint, spacing, radius, type as typeScale } from '../../theme';

const TERMS_BODY_IT = `## Il servizio
Arvo ti aiuta a seguire i tuoi campi con dati satellitari, meteo e rilievi. Le indicazioni sono un supporto alle decisioni: non sostituiscono il parere di un agronomo.

## Il tuo account
Custodisci con cura le credenziali e ciò che inserisci. Puoi invitare altre persone della tua azienda e decidere i loro ruoli.

## I tuoi dati restano tuoi
Campi, rilievi e foto sono tuoi. Ci dai solo il permesso tecnico di conservarli ed elaborarli per te. Puoi esportarli o cancellarli quando vuoi; non li rivendiamo a nessuno.

## Uso corretto
Niente usi illegali o dannosi per altri. Possiamo sospendere gli account che abusano del servizio.

## Limiti del servizio
Il servizio è fornito "così com'è": satellite e meteo possono avere ritardi o imprecisioni. Nei limiti di legge non rispondiamo delle decisioni agronomiche prese sulla base dell'app.

## Modifiche
Se questi termini cambiano in modo sostanziale te lo diciamo nell'app con un preavviso ragionevole.

## Legge applicabile
Valgono la legge italiana e, dove previsto, il foro del consumatore.`;

export default function TermsScreen() {
  const { t } = useTranslation();
  const body = t('legal.terms_body', { defaultValue: TERMS_BODY_IT });
  return (
    <>
      <Stack.Screen
        options={{ title: t('legal.terms_title', { defaultValue: 'Termini di servizio' }) }}
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
          {t('legal.terms_title', { defaultValue: 'Termini di servizio' })}
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
