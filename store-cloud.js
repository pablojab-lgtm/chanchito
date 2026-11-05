// Sincronización con Firebase (Firestore + login con Google). Misma interfaz que store-local.js.
const V = '10.12.2';
const BASE = `https://www.gstatic.com/firebasejs/${V}`;

export async function createCloud(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${BASE}/firebase-app.js`),
    import(`${BASE}/firebase-auth.js`),
    import(`${BASE}/firebase-firestore.js`),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  const db = F.initializeFirestore(app, {
    ignoreUndefinedProperties: true,
    localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }), // funciona sin señal
  });

  // Si el login fue por redirección (celulares), completarlo.
  A.getRedirectResult(auth).catch(() => {});

  const me = () => {
    const u = auth.currentUser;
    return u ? { uid: u.uid, name: (u.displayName || u.email || 'Yo').split(' ')[0] } : null;
  };

  return {
    me,
    onAuth: cb => A.onAuthStateChanged(auth, cb),
    async signIn() {
      const provider = new A.GoogleAuthProvider();
      try { await A.signInWithPopup(auth, provider); }
      catch (e) {
        if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
        if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') return A.signInWithRedirect(auth, provider);
        throw e;
      }
    },
    signOut: () => A.signOut(auth),

    async getHouseholdId() {
      const snap = await F.getDoc(F.doc(db, 'users', auth.currentUser.uid));
      return snap.exists() ? snap.data().householdId || null : null;
    },
    async createHousehold(data) {
      const ref = F.doc(F.collection(db, 'households'));
      await F.setDoc(ref, data);
      await F.setDoc(F.doc(db, 'users', auth.currentUser.uid), { householdId: ref.id }, { merge: true });
      return ref.id;
    },
    async join(hid) {
      const m = me();
      await F.updateDoc(F.doc(db, 'households', hid), {
        members: F.arrayUnion(m.uid),
        [`memberNames.${m.uid}`]: m.name,
      });
      await F.setDoc(F.doc(db, 'users', m.uid), { householdId: hid }, { merge: true });
    },

    open(hid) {
      const hRef = F.doc(db, 'households', hid);
      const movCol = F.collection(hRef, 'movements');
      const recCol = F.collection(hRef, 'recurring');
      const state = { household: null, movements: null, recurring: null };
      const subs = new Set();
      const unsubs = [];
      const emit = () => {
        if (!state.household || !state.movements || !state.recurring) return;
        const snap = { household: state.household, movements: state.movements, recurring: state.recurring };
        subs.forEach(cb => cb(snap));
      };
      const start = () => {
        unsubs.push(F.onSnapshot(hRef, s => { state.household = s.data(); emit(); }, err => console.error(err)));
        unsubs.push(F.onSnapshot(movCol, s => { state.movements = s.docs.map(d => ({ ...d.data(), id: d.id })); emit(); }, err => console.error(err)));
        unsubs.push(F.onSnapshot(recCol, s => { state.recurring = s.docs.map(d => ({ ...d.data(), id: d.id })); emit(); }, err => console.error(err)));
      };
      const clean = o => { const { id, ...rest } = o; return rest; };

      return {
        mode: 'cloud',
        householdId: hid,
        me: me(),
        signOut: () => A.signOut(auth),
        subscribe(cb) { subs.add(cb); if (!unsubs.length) start(); else emit(); return () => subs.delete(cb); },
        close() { unsubs.forEach(u => u()); unsubs.length = 0; subs.clear(); },
        addMovement: m => F.addDoc(movCol, { ...m, createdAt: Date.now() }),
        updateMovement: (id, patch) => F.updateDoc(F.doc(movCol, id), patch),
        deleteMovement: id => F.deleteDoc(F.doc(movCol, id)),
        async saveRecurring(r) {
          if (r.id) await F.updateDoc(F.doc(recCol, r.id), clean(r));
          else await F.addDoc(recCol, { ...r, doneMonths: [], createdAt: Date.now() });
        },
        deleteRecurring: id => F.deleteDoc(F.doc(recCol, id)),
        updateHousehold: patch => F.updateDoc(hRef, patch),
        async materialize(rule, month, movement) {
          // id fijo por regla+mes: si dos celulares lo generan a la vez, no se duplica.
          const batch = F.writeBatch(db);
          batch.set(F.doc(movCol, `${rule.id}_${month}`), { ...movement, createdAt: Date.now() });
          batch.update(F.doc(recCol, rule.id), { doneMonths: F.arrayUnion(month) });
          await batch.commit();
        },
      };
    },
  };
}
