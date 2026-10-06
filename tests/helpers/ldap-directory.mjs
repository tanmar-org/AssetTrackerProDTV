import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Attribute, BerReader, BerWriter } from "ldapts";

const execute = promisify(execFile);
// ldapts exports client response readers, so construct server response BER here.
function response(messageId, operation, body) {
  const writer = new BerWriter(); writer.startSequence(); writer.writeInt(messageId);
  writer.startSequence(operation); body(writer); writer.endSequence(); writer.endSequence(); return writer.buffer;
}
const result = (messageId, operation, status) => response(messageId, operation, writer => {
  writer.writeEnumeration(status); writer.writeString(""); writer.writeString(status ? "Synthetic directory rejection" : "");
});
export const directoryGuid = "12345678-90ab-cdef-8123-456789abcdef";
export const directoryBytes = Buffer.from("78563412ab90efcd8123456789abcdef", "hex");
export function syntheticAdEntry(overrides = {}) {
  return { guid: directoryGuid, bytes: directoryBytes, username: "j.doe", dn: "CN=Synthetic Staff,DC=example,DC=invalid",
    password: "Synthetic AD password 007!", flags: "512", computed: "0", stamp: "134000000000000000", expires: "0", ...overrides };
}

// A narrow synthetic LDAP server over actual TLS. Parse equality filter octets
// independently so tests detect binary GUID corruption by client text encoding.
// It supports only bind/search, never production directories or write operations.
export async function createLdapDirectory({ certificateHost = "localhost" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "assettracker-ldap-test-"));
  const caFile = join(directory, "ca.pem"), certFile = join(directory, "server.pem"), keyFile = join(directory, "server.key");
  const sockets = new Set(), errors = [];
  let server;
  try {
    await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "ca.key"),
      "-out", caFile, "-days", "2", "-subj", "/CN=Synthetic AD Test CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
    await execute("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile,
      "-out", join(directory, "server.csr"), "-subj", `/CN=${certificateHost}`]);
    await writeFile(join(directory, "extensions"), `subjectAltName=DNS:${certificateHost}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
    await execute("openssl", ["x509", "-req", "-in", join(directory, "server.csr"), "-CA", caFile,
      "-CAkey", join(directory, "ca.key"), "-CAcreateserial", "-out", certFile, "-days", "2", "-extfile", join(directory, "extensions")]);
    const model = { entries: [syntheticAdEntry()], reader: "CN=Synthetic Reader,DC=example,DC=invalid",
      readerPassword: "Synthetic reader password!", requests: [], stall: false, duplicate: false, referral: false,
      domainPartitions: true, rejectDomainScope: false, omit: null, onUserBind: null, operationDelayMs: 0 };
    const filters = reader => {
      const tag = reader.readSequence(), end = reader.offset + reader.length;
      if (tag === 0xa0) { const result = []; while (reader.offset < end) result.push(...filters(reader)); return result; }
      if (tag !== 0xa3) throw new Error("Synthetic directory accepts equality filters only.");
      return [{ attribute: reader.readString().toLowerCase(), value: reader.readString(4, true) }];
    };
    server = createServer({ cert: await readFile(certFile), key: await readFile(keyFile), minVersion: "TLSv1.2" }, socket => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
      let pending = Buffer.alloc(0), bound = false, chain = Promise.resolve();
      const message = async packet => {
        const reader = new BerReader(packet); reader.readSequence(); const messageId = reader.readInt(), operation = reader.readSequence();
        if (model.stall) return;
        if (model.operationDelayMs) await delay(model.operationDelayMs);
        if (operation === 0x60) {
          reader.readInt(); const dn = reader.readString(), password = reader.readString(0x80);
          const entry = model.entries.find(entry => entry.dn === dn);
          bound = dn === model.reader && password === model.readerPassword;
          const valid = bound || (entry && password === entry.password);
          model.requests.push({ type: "bind", reader: bound, dn });
          if (valid && !bound) await model.onUserBind?.(entry);
          socket.write(result(messageId, 0x61, valid ? 0 : 49));
          return;
        }
        if (operation === 0x42) { socket.end(); return; }
        if (operation !== 0x63) throw new Error("Unexpected synthetic LDAP operation.");
        const base = reader.readString(), scope = reader.readEnumeration(), aliases = reader.readEnumeration();
        const sizeLimit = reader.readInt(), timeLimit = reader.readInt(); reader.readBoolean();
        const conditions = filters(reader); reader.readSequence(); const end = reader.offset + reader.length, attributes = [];
        while (reader.offset < end) attributes.push(reader.readString());
        // Decode the actual wire control independently, including criticality
        // and absence of a value; importing the production control would mask bugs.
        const controls = [];
        if (reader.offset < packet.length) {
          if (reader.readSequence() !== 0xa0) throw new Error("Unexpected LDAP message extension.");
          const controlsEnd = reader.offset + reader.length;
          while (reader.offset < controlsEnd) {
            if (reader.readSequence() !== 0x30) throw new Error("Malformed LDAP control.");
            const controlEnd = reader.offset + reader.length, type = reader.readString();
            const critical = reader.peek() === 0x01 ? reader.readBoolean() : false;
            const value = reader.offset < controlEnd ? reader.readString(0x04, true) : undefined;
            if (reader.offset !== controlEnd) throw new Error("Unexpected LDAP control data.");
            controls.push({ type, critical, ...(value === undefined ? {} : { value }) });
          }
          if (reader.offset !== controlsEnd || controlsEnd !== packet.length) throw new Error("Trailing LDAP control data.");
        }
        model.requests.push({ type: "search", base, scope, aliases, sizeLimit, timeLimit, attributes, conditions, controls });
        if (!bound) { socket.write(result(messageId, 0x65, 50)); return; }
        const domainScope = controls.find(control => control.type === "1.2.840.113556.1.4.1339");
        if (model.rejectDomainScope && domainScope?.critical) { socket.write(result(messageId, 0x65, 12)); return; }
        // Normal AD domain-root continuation references accompany an otherwise
        // valid user. A separate switch simulates a server violating DOMAIN_SCOPE.
        if (model.domainPartitions && !domainScope) for (const partition of ["ForestDnsZones", "DomainDnsZones", "OtherPartition"])
          socket.write(response(messageId, 0x73, writer => writer.writeString(`ldaps://outside.example.invalid/${partition}`)));
        if (model.referral) socket.write(response(messageId, 0x73, writer => writer.writeString("ldaps://outside.example.invalid")));
        const matches = model.entries.filter(entry => conditions.every(({ attribute, value }) => {
          if (attribute === "objectguid") return entry.bytes.equals(value);
          const values = { objectcategory: "person", objectclass: "user", samaccountname: entry.username };
          return values[attribute]?.toLowerCase() === value.toString().toLowerCase();
        }));
        for (const entry of model.duplicate ? [...matches, ...matches] : matches) {
          const values = { objectGUID: entry.bytes, sAMAccountName: entry.username, userAccountControl: entry.flags,
            "msDS-User-Account-Control-Computed": entry.computed, pwdLastSet: entry.stamp, accountExpires: entry.expires };
          socket.write(response(messageId, 0x64, writer => {
            writer.writeString(entry.dn); writer.startSequence();
            for (const [type, value] of Object.entries(values)) if (attributes.includes(type) && type !== model.omit)
              new Attribute({ type, values: [value] }).write(writer);
            writer.endSequence();
          }));
        }
        socket.write(result(messageId, 0x65, 0));
      };
      socket.on("data", chunk => {
        pending = Buffer.concat([pending, chunk]);
        try {
          while (pending.length > 2) {
            const header = new BerReader(pending);
            if (header.readSequence() === null || header.length === null || header.offset + header.length > pending.length) break;
            const size = header.offset + header.length, packet = pending.subarray(0, size); pending = pending.subarray(size);
            chain = chain.then(() => message(packet)).catch(error => { errors.push(error); socket.destroy(); });
          }
        } catch (error) { errors.push(error); socket.destroy(); }
      });
    });
    server.on("tlsClientError", () => {}); // Expected certificate-rejection scenarios.
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const env = { AUTH_MODE: "ad", AD_DIRECTORY_ID: "synthetic-ad", AD_LDAP_URL: `ldaps://localhost:${server.address().port}`,
      AD_BASE_DN: "DC=example,DC=invalid", AD_BIND_DN: model.reader, AD_BIND_PASSWORD: model.readerPassword, AD_CA_FILE: caFile };
    return { model, env, errors, caFile, close: async () => {
      for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) {
    for (const socket of sockets) socket.destroy(); server?.close();
    await rm(directory, { recursive: true, force: true }); throw error;
  }
}
