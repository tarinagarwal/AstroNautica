import React, { type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n";
import { useNav } from "../nav";
import { colors, fontForText, space } from "../theme";

export function Txt({
  children,
  style,
  muted,
  bold,
  size,
  selectable,
  numberOfLines,
  lang,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  muted?: boolean;
  bold?: boolean;
  size?: number;
  selectable?: boolean;
  numberOfLines?: number;
  /** Language of the text itself when it differs from the UI language (story content). */
  lang?: "en" | "hi";
}) {
  const { font, lang: ui } = useI18n();
  const family = lang ? (lang === "hi" ? "NotoSansDevanagari" : "NotoSans") : typeof children === "string" ? fontForText(children, ui) : font;
  return (
    <Text
      selectable={selectable}
      numberOfLines={numberOfLines}
      style={[
        { fontFamily: family, color: muted ? colors.muted : colors.text, fontSize: size ?? 16, lineHeight: (size ?? 16) * 1.45 },
        bold && { fontWeight: "700" },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function Button({
  title,
  onPress,
  kind = "primary",
  disabled,
  busy,
  style,
  small,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger" | "link";
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const bg = kind === "primary" ? colors.primary : kind === "danger" ? colors.badBg : kind === "link" ? "transparent" : colors.card;
  const fg = kind === "primary" ? colors.primaryText : kind === "danger" ? colors.bad : kind === "link" ? colors.link : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy }}
      onPress={disabled || busy ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: bg, borderColor: kind === "secondary" ? colors.border : bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Txt style={{ color: fg, textAlign: "center" }} bold={kind !== "link"} size={small ? 14 : 16}>{title}</Txt>}
    </Pressable>
  );
}

export function Header({ title, right }: { title: string; right?: ReactNode }) {
  const nav = useNav();
  const { t, lang, setLang } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + space.s }]}>
      {nav.depth > 1 ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("common.back")} onPress={() => nav.back()} style={styles.headerBtn}>
          <Txt size={22}>‹</Txt>
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={t("nav.menu")} onPress={() => nav.push({ name: "menu" })} style={styles.headerBtn}>
          <Txt size={22}>☰</Txt>
        </Pressable>
      )}
      <Txt bold size={18} numberOfLines={1} style={{ flex: 1 }}>
        {title}
      </Txt>
      {right}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("lang.switch")}
        onPress={() => setLang(lang === "en" ? "hi" : "en")}
        style={styles.headerBtn}
      >
        <Txt bold size={14} lang={lang === "en" ? "hi" : "en"}>
          {lang === "en" ? t("lang.hi") : t("lang.en")}
        </Txt>
      </Pressable>
    </View>
  );
}

export function Screen({ title, children, scroll = true, right }: { title: string; children: ReactNode; scroll?: boolean; right?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.screen}>
      <Header title={title} right={right} />
      {scroll ? (
        <ScrollView contentContainerStyle={{ padding: space.l, paddingBottom: insets.bottom + space.xl }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingBottom: insets.bottom }}>{children}</View>
      )}
    </View>
  );
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  if (onPress)
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [styles.card, { opacity: pressed ? 0.85 : 1 }, style]}>
        {children}
      </Pressable>
    );
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={{ marginBottom: space.xl }}>
      {title ? (
        <Txt bold size={18} style={{ marginBottom: space.s }}>
          {title}
        </Txt>
      ) : null}
      {children}
    </View>
  );
}

export function Field(props: TextInputProps & { label: string; help?: string }) {
  const { font } = useI18n();
  const { label, help, style, ...rest } = props;
  return (
    <View style={{ marginBottom: space.m }}>
      <Txt muted size={14} style={{ marginBottom: space.xs }}>
        {label}
      </Txt>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        style={[styles.input, { fontFamily: font }, rest.multiline && { minHeight: 96, textAlignVertical: "top" }, style]}
        {...rest}
      />
      {help ? (
        <Txt muted size={13} style={{ marginTop: space.xs }}>
          {help}
        </Txt>
      ) : null}
    </View>
  );
}

export function Badge({ label, tone }: { label: string; tone: "ok" | "bad" | "neutral" | "warn" }) {
  const bg = tone === "ok" ? colors.okBg : tone === "bad" ? colors.badBg : tone === "warn" ? colors.warnBg : colors.code;
  const fg = tone === "ok" ? colors.ok : tone === "bad" ? colors.bad : colors.text;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Txt size={13} bold style={{ color: fg }}>
        {label}
      </Txt>
    </View>
  );
}

export function Notice({ children, tone = "warn" }: { children: ReactNode; tone?: "ok" | "bad" | "warn" }) {
  const bg = tone === "ok" ? colors.okBg : tone === "bad" ? colors.badBg : colors.warnBg;
  return <View style={[styles.notice, { backgroundColor: bg }]}>{typeof children === "string" ? <Txt size={15}>{children}</Txt> : children}</View>;
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.s }, style]}>{children}</View>;
}

export function Toggle({ label, value, onChange, help }: { label: string; value: boolean; onChange: (v: boolean) => void; help?: string }) {
  return (
    <View style={{ marginBottom: space.m }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Txt style={{ flex: 1 }}>{label}</Txt>
        <Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: colors.primary, false: colors.border }} />
      </View>
      {help ? (
        <Txt muted size={13}>
          {help}
        </Txt>
      ) : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={{ padding: space.xl, alignItems: "center" }}>
      <ActivityIndicator color={colors.primary} />
      {label ? (
        <Txt muted style={{ marginTop: space.s }}>
          {label}
        </Txt>
      ) : null}
    </View>
  );
}

export function Choice<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <Row style={{ marginBottom: space.m }}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          accessibilityRole="radio"
          accessibilityState={{ selected: o.value === value }}
          onPress={() => onChange(o.value)}
          style={[styles.choice, o.value === value && { backgroundColor: colors.primary, borderColor: colors.primary }]}
        >
          <Txt size={14} bold style={{ color: o.value === value ? colors.primaryText : colors.text }}>
            {o.label}
          </Txt>
        </Pressable>
      ))}
    </Row>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.s,
    paddingBottom: space.s,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: space.s,
  },
  headerBtn: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: space.s },
  button: { paddingVertical: space.m, paddingHorizontal: space.l, borderRadius: 8, borderWidth: 1, minHeight: 48, justifyContent: "center", marginVertical: space.xs },
  buttonSmall: { paddingVertical: space.s, paddingHorizontal: space.m, minHeight: 40 },
  card: { backgroundColor: colors.card, borderRadius: 10, padding: space.l, marginBottom: space.m, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: 16, color: colors.text, backgroundColor: colors.card },
  badge: { paddingHorizontal: space.s, paddingVertical: 2, borderRadius: 6, alignSelf: "flex-start" },
  notice: { padding: space.m, borderRadius: 8, marginBottom: space.m },
  choice: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: space.m, paddingVertical: space.s, backgroundColor: colors.card },
});
